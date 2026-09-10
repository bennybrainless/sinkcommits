local WidgetContainer = require("ui/widget/container/widgetcontainer")
local UIManager = require("ui/uimanager")
local NetworkMgr = require("ui/network/manager")
local Notification = require("ui/widget/notification")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local ConfirmBox = require("ui/widget/confirmbox")
local Device = require("device")
local logger = require("logger")
local json = require("json")
local socket = require("socket")
local http = require("socket.http")
local https = require("ssl.https")
local ltn12 = require("ltn12")
local _ = require("gettext")

local Event = nil
pcall(function() Event = require("ui/event") end)
local util = nil
pcall(function() util = require("util") end)

local plugin_path = ((...) or ""):match("(.-)[^%.]+$") or ""
local SinkPairing = nil
pcall(function()
    SinkPairing = require(plugin_path .. "sink_pairing")
end)

local DataStorage = nil
local LuaSettings = nil
pcall(function()
    DataStorage = require("datastorage")
    LuaSettings = require("luasettings")
end)

local Sink = WidgetContainer:extend{
    name = "sink",
    is_doc_only = false,
}

-- Default Configuration
local DEFAULT_SETTINGS = {
    server_url = "https://sink.your-subdomain.workers.dev",
    username = "",
    userkey = "",
    auto_sync = true,
    last_sync_time = 0,
    last_sync_doc = "",
}

function Sink:init()
    self.ui.menu:registerToMainMenu(self)
    self:loadSettings()
    self.is_reader_ready = false
    self.last_page_sync = 0
end

function Sink:getSettingsPath()
    local dir = (DataStorage and DataStorage.getDataDir and DataStorage:getDataDir()) or "."
    return dir .. "/sink_settings.lua"
end

function Sink:loadSettings()
    local loaded = nil
    if LuaSettings then
        local ok, storage = pcall(function() return LuaSettings:open(self:getSettingsPath()) end)
        if ok and storage then
            self.settings_storage = storage
            loaded = storage:readSetting("sink_sync")
        end
    end
    if not loaded and _G.G_reader_settings then
        loaded = G_reader_settings:readSetting("sink_sync")
    end
    self.settings = loaded or {}
    for k, v in pairs(DEFAULT_SETTINGS) do
        if self.settings[k] == nil then
            self.settings[k] = v
        end
    end
end

function Sink:saveSettings()
    if not self.settings_storage and LuaSettings then
        pcall(function()
            self.settings_storage = LuaSettings:open(self:getSettingsPath())
        end)
    end
    if self.settings_storage then
        self.settings_storage:saveSetting("sink_sync", self.settings)
        pcall(function() self.settings_storage:flush() end)
    end
    if _G.G_reader_settings then
        G_reader_settings:saveSetting("sink_sync", self.settings)
        if G_reader_settings.flush then
            pcall(function() G_reader_settings:flush() end)
        end
    end
end

--------------------------------------------------------------------------------
-- HTTP & API Client Helper
--------------------------------------------------------------------------------

local function trim(s)
    if not s then return "" end
    return s:match("^%s*(.-)%s*$")
end

local function cleanUrl(url)
    url = trim(url)
    if url:sub(-1) == "/" then
        url = url:sub(1, -2)
    end
    return url
end

function Sink:_makeRequest(method, endpoint, body_table)
    local server_url = cleanUrl(self.settings.server_url)
    if not server_url or server_url == "" then
        return nil, "Server URL is not configured."
    end

    local url = server_url .. endpoint
    local req_body = nil
    local headers = {
        ["Accept"] = "application/vnd.koreader.v1+json, application/json",
        ["x-auth-user"] = self.settings.username or "",
        ["x-auth-key"] = self.settings.userkey or "",
    }

    if body_table then
        req_body = json.encode(body_table)
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = tostring(#req_body)
    end

    local response_body = {}
    local protocol = url:match("^(https?)://")
    local request_fn = (protocol == "https") and https.request or http.request

    local ok, code, resp_headers, status_line
    local pcall_ok, pcall_err = pcall(function()
        ok, code, resp_headers, status_line = request_fn{
            url = url,
            method = method,
            headers = headers,
            source = req_body and ltn12.source.string(req_body) or nil,
            sink = ltn12.sink.table(response_body),
            timeout = 10,
        }
    end)

    if not pcall_ok then
        return nil, "Network error: " .. tostring(pcall_err)
    end

    local raw_res = table.concat(response_body)
    local decoded = nil
    if raw_res and #raw_res > 0 then
        pcall(function() decoded = json.decode(raw_res) end)
    end

    return {
        status = tonumber(code) or code or 0,
        headers = resp_headers or {},
        body = decoded or {},
        raw = raw_res,
    }, nil
end

--------------------------------------------------------------------------------
-- Document & Progress Utilities
--------------------------------------------------------------------------------

function Sink:_getDocumentMD5()
    if not self.ui then return nil end

    -- 1. Read partial_md5_checksum from document settings or readerui (standard KOReader key)
    if self.ui.doc_settings then
        local checksum = self.ui.doc_settings:readSetting("partial_md5_checksum")
        if checksum and checksum ~= "" then
            return checksum
        end
        local legacy = self.ui.doc_settings:readSetting("doc_md5") or self.ui.doc_settings:readSetting("md5")
        if legacy and legacy ~= "" then
            return legacy
        end
    end
    if self.ui.md5_checksum and self.ui.md5_checksum ~= "" then
        return self.ui.md5_checksum
    end

    -- 2. Fallback using document object or file path
    if self.ui.document then
        if self.ui.document.checksum and self.ui.document.checksum ~= "" then
            return self.ui.document.checksum
        end
        if self.ui.document.fastDigest then
            local ok, digest = pcall(function() return self.ui.document:fastDigest() end)
            if ok and digest and digest ~= "" then
                return digest
            end
        end
        if self.ui.document.file then
            local ok, md5_val = pcall(function()
                local u = require("util")
                return u.partialMD5(self.ui.document.file)
            end)
            if ok and md5_val and md5_val ~= "" then
                return md5_val
            end

            -- 3. Cross-device filename hash fallback (for identical book files across devices)
            local ok_fn, fn_hash = pcall(function()
                local u = require("util")
                local _, filename = u.splitFilePathName(self.ui.document.file)
                if filename and filename ~= "" then
                    return u.md5(filename)
                end
            end)
            if ok_fn and fn_hash and fn_hash ~= "" then
                return fn_hash
            end
        end
    end

    return nil
end

function Sink:_getLocalProgress()
    if not self.ui or not self.ui.document then return nil, nil end
    local progress = nil
    local percentage = nil

    local has_pages = self.ui.document.info and self.ui.document.info.has_pages

    if has_pages then
        -- Paginated document (PDF, DJVU, CBZ, etc.)
        if self.ui.paging then
            if self.ui.paging.getLastProgress then
                local ok, p = pcall(function() return self.ui.paging:getLastProgress() end)
                if ok and p then progress = tostring(p) end
            end
            if not progress and self.ui.paging.current_page then
                progress = tostring(self.ui.paging.current_page)
            end

            if self.ui.paging.getLastPercent then
                local ok, pct = pcall(function() return self.ui.paging:getLastPercent() end)
                if ok and pct then percentage = tonumber(pct) end
            end
        end

        if not progress and self.ui.getCurrentPage then
            local ok, p = pcall(function() return self.ui:getCurrentPage() end)
            if ok and p then progress = tostring(p) end
        end

        if not percentage and self.ui.document.totalPages and self.ui.document.totalPages > 0 and tonumber(progress) then
            percentage = tonumber(progress) / self.ui.document.totalPages
        end
    else
        -- Reflowable document (EPUB, MOBI, FB2, TXT, etc.)
        if self.ui.rolling then
            if self.ui.rolling.getLastProgress then
                local ok, p = pcall(function() return self.ui.rolling:getLastProgress() end)
                if ok and p then progress = tostring(p) end
            end
            if self.ui.rolling.getLastPercent then
                local ok, pct = pcall(function() return self.ui.rolling:getLastPercent() end)
                if ok and pct then percentage = tonumber(pct) end
            end
        end

        if not progress and self.ui.doc_settings then
            progress = self.ui.doc_settings:readSetting("last_xpointer")
        end
        if not progress and self.ui.bookmark and self.ui.bookmark.getProgress then
            local ok, p = pcall(function() return self.ui.bookmark:getProgress() end)
            if ok and p then progress = tostring(p) end
        end
        if not progress and self.ui.document and self.ui.document.getXPointer then
            local ok, p = pcall(function() return self.ui.document:getXPointer() end)
            if ok and p then progress = tostring(p) end
        end
        if not progress and self.ui.paging and self.ui.paging.current_page then
            progress = tostring(self.ui.paging.current_page)
        end
    end

    -- Extract percentage from doc_settings if not yet populated
    if not percentage and self.ui.doc_settings then
        percentage = tonumber(self.ui.doc_settings:readSetting("percent_finished"))
    end

    if not percentage and progress then
        percentage = 0.0
    end

    return percentage, progress
end

function Sink:_applyRemoteProgress(remote_progress, remote_percentage)
    if not self.ui or not remote_progress then return end

    if not Event then
        pcall(function() Event = require("ui/event") end)
    end

    local has_pages = self.ui.document and self.ui.document.info and self.ui.document.info.has_pages

    if Event and self.ui.handleEvent then
        if has_pages then
            local page = tonumber(remote_progress)
            if page then
                self.ui:handleEvent(Event:new("GotoPage", page))
                return
            end
        else
            self.ui:handleEvent(Event:new("GotoXPointer", tostring(remote_progress)))
            return
        end
    end

    -- Fallback navigation handlers
    if self.ui.bookmark and self.ui.bookmark.restoreProgress then
        pcall(function() self.ui.bookmark:restoreProgress(remote_progress) end)
    elseif self.ui.gotoXPointer then
        pcall(function() self.ui:gotoXPointer(tostring(remote_progress)) end)
    elseif self.ui.gotoPage and tonumber(remote_progress) then
        pcall(function() self.ui:gotoPage(tonumber(remote_progress)) end)
    end
end

function Sink:_getDeviceInfo()
    local model = "Device"
    if Device then
        if Device.getModel then
            pcall(function() model = Device:getModel() end)
        elseif Device.model then
            model = tostring(Device.model)
        end
    end

    if not self.settings.device_id or self.settings.device_id == "" or self.settings.device_id == "kindle_device" then
        local u = nil
        pcall(function() u = require("util") end)
        if u and u.genUUID then
            self.settings.device_id = u.genUUID()
        else
            self.settings.device_id = string.format("dev_%d_%d", os.time(), math.random(1000, 9999))
        end
        self:saveSettings()
    end

    return model, self.settings.device_id
end

--------------------------------------------------------------------------------
-- Core Sync Actions
--------------------------------------------------------------------------------

-- Perform sync for the current document
-- is_manual: boolean flag. If true, show user-facing notifications/alerts.
-- is_pull_only: boolean flag. If true (e.g. on opening a book), only pull, never overwrite cloud with 0%.
function Sink:_syncDocument(is_manual, is_pull_only)
    if not self.settings.username or self.settings.username == "" then
        if is_manual then
            UIManager:show(InfoMessage:new{
                text = _("Please pair your device or configure credentials in settings."),
            })
        end
        return false
    end

    local doc_md5 = self:_getDocumentMD5()
    if not doc_md5 then
        if is_manual then
            UIManager:show(InfoMessage:new{
                text = _("No active document found to sync."),
            })
        end
        return false
    end

    local local_pct, local_prog = self:_getLocalProgress()
    if not local_pct or not local_prog then
        logger.warn("Sink: unable to extract local progress for document " .. tostring(doc_md5))
        return false
    end

    local doc_name = (self.ui.doc_props and self.ui.doc_props.title) or (self.ui.document and self.ui.document.file) or "Document"
    logger.info(string.format("Sink: checking sync for document %s (%s, local: %.1f%%, %s)", tostring(doc_md5), tostring(doc_name), (local_pct or 0) * 100, tostring(local_prog)))

    -- 1. Fetch remote progress
    local res, err = self:_makeRequest("GET", "/syncs/progress/" .. doc_md5)
    if err or not res or (res.status ~= 200 and res.status ~= 201) then
        logger.warn("Sink: error fetching remote progress: " .. tostring(err or res and res.status))
        if is_manual then
            UIManager:show(InfoMessage:new{
                text = _("Failed to sync progress:\n") .. tostring(err or (res and res.raw) or "Unknown error"),
            })
        end
        return false
    end

    local remote = res.body or {}
    local remote_pct = tonumber(remote.percentage)
    local remote_prog = remote.progress
    local remote_ts = tonumber(remote.timestamp) or 0
    local local_ts = tonumber(self.settings.last_sync_time) or 0

    local dev_model, dev_id = self:_getDeviceInfo()

    if not remote_prog or not remote_pct then
        logger.info(string.format("Sink: no progress found on server for document %s", tostring(doc_md5)))
    else
        logger.info(string.format("Sink: server progress is %.1f%% (%s) from device '%s' (ts: %s)",
            remote_pct * 100, tostring(remote_prog), tostring(remote.device or "unknown"), tostring(remote_ts)))
    end

    -- Determine if remote progress should be pulled:
    local is_same_progress = (remote_pct and math.abs(remote_pct - local_pct) < 0.0001) or (remote_prog and remote_prog == local_prog)
    local is_local_at_start = (local_pct or 0) <= 0.01
    local is_remote_ahead = remote_pct and (remote_pct > (local_pct + 0.0001))
    local is_remote_newer = remote_ts > (local_ts + 2) and (not remote.device_id or remote.device_id ~= dev_id)

    -- Pull conditions:
    -- 1. Local is at start (0-1%) and remote has progress -> Pull!
    -- 2. Remote is further ahead -> Pull!
    -- 3. Remote is newer from another device -> Pull!
    if not is_same_progress and remote_prog and remote_pct and (is_local_at_start or is_remote_ahead or is_remote_newer) then
        logger.info(string.format("Sink: pulling remote progress: jumping from %.1f%% to %.1f%% (%s)", (local_pct or 0) * 100, remote_pct * 100, remote.device or "Remote"))
        self:_applyRemoteProgress(remote_prog, remote_pct)
        self.settings.last_sync_time = remote_ts > 0 and remote_ts or os.time()
        self.settings.last_sync_doc = doc_md5
        self:saveSettings()

        if is_manual then
            UIManager:show(Notification:new{
                text = string.format(_("Synced from cloud: %.1f%% (%s)"), remote_pct * 100, remote.device or "Remote"),
            })
        end
        return true
    elseif is_same_progress then
        logger.info(string.format("Sink: progress already in sync at %.1f%%", (local_pct or 0) * 100))
        if is_manual then
            UIManager:show(Notification:new{
                text = string.format(_("Already in sync: %.1f%%"), (local_pct or 0) * 100),
            })
        end
        return true
    elseif not is_pull_only then
        -- Push local progress to cloud
        logger.info(string.format("Sink: pushing local progress: %.1f%% to cloud", (local_pct or 0) * 100))
        local push_res, push_err = self:_makeRequest("PUT", "/syncs/progress", {
            document = doc_md5,
            percentage = local_pct,
            progress = local_prog,
            device = dev_model,
            device_id = dev_id,
        })

        if push_err or not push_res or push_res.status ~= 200 then
            logger.warn("Sink: error pushing progress: " .. tostring(push_err or push_res and push_res.status))
            if is_manual then
                UIManager:show(InfoMessage:new{
                    text = _("Failed to upload progress:\n") .. tostring(push_err or (push_res and push_res.raw) or "Unknown error"),
                })
            end
            return false
        end

        local ts = (push_res.body and push_res.body.timestamp) or os.time()
        self.settings.last_sync_time = ts
        self.settings.last_sync_doc = doc_md5
        self:saveSettings()

        if is_manual then
            UIManager:show(Notification:new{
                text = string.format(_("Synced to cloud: %.1f%%"), local_pct * 100),
            })
        end
        return true
    else
        logger.info("Sink: pull-only sync completed. Local is at start or no remote progress to apply.")
        return true
    end
end

--------------------------------------------------------------------------------
-- Non-Intrusive Lifecycle Hooks
-- Crucial: Must NEVER trigger Wi-Fi popups in background.
-- Uses NetworkMgr:isOnline() and completely suppresses errors.
--------------------------------------------------------------------------------

function Sink:_silentBackgroundSync(trigger_name, is_pull_only)
    if not self.settings.auto_sync then
        return
    end

    -- Non-intrusive check: is the device currently connected to Wi-Fi?
    if not NetworkMgr:isOnline() then
        logger.info("Sink [" .. trigger_name .. "]: Device is offline. Silently skipping sync.")
        return
    end

    logger.info("Sink [" .. trigger_name .. "]: Device online. Performing silent sync.")
    local ok, err = pcall(function()
        self:_syncDocument(false, is_pull_only)
    end)
    if not ok then
        -- Suppress all background errors
        logger.warn("Sink [" .. trigger_name .. "] silent sync error: " .. tostring(err))
    end
end

function Sink:onReaderReady()
    self.is_reader_ready = false
    UIManager:scheduleIn(0.5, function()
        self.is_reader_ready = true
        self:_silentBackgroundSync("onReaderReady", true)
    end)
end

function Sink:onPageUpdate(page)
    if not self.is_reader_ready then
        -- Ignore initial layout page events before document has finished loading/pulling
        return
    end

    local now = os.time()
    if not self.last_page_sync or (now - self.last_page_sync) >= 20 then
        self.last_page_sync = now
        self:_silentBackgroundSync("onPageUpdate", false)
    end
end

function Sink:onCloseDocument()
    self.is_reader_ready = false
    self:_silentBackgroundSync("onCloseDocument", false)
end

function Sink:onSuspend()
    self:_silentBackgroundSync("onSuspend", false)
end

function Sink:onResume()
    UIManager:scheduleIn(1.0, function()
        self:_silentBackgroundSync("onResume", true)
    end)
end

function Sink:onNetworkConnected()
    UIManager:scheduleIn(1.0, function()
        self:_silentBackgroundSync("onNetworkConnected", true)
    end)
end

--------------------------------------------------------------------------------
-- User Interface & Configuration Menu
--------------------------------------------------------------------------------

local Dispatcher = nil
pcall(function() Dispatcher = require("dispatcher") end)

function Sink:onDispatcherRegisterActions()
    if Dispatcher then
        Dispatcher:registerAction("sink_sync_now", {
            category = "none",
            event = "SinkSyncNow",
            title = _("Sink: Sync Now"),
            general = true,
        })
        Dispatcher:registerAction("sink_pair", {
            category = "none",
            event = "SinkPair",
            title = _("Sink: Pair Device"),
            general = true,
        })
    end
end

function Sink:onSinkSyncNow()
    self:_syncDocument(true)
end

function Sink:onSinkPair()
    if SinkPairing then
        SinkPairing:startPairing(self, function()
            self:_syncDocument(false)
        end)
    end
end

local function injectSinkIntoToolsMenu()
    local menu_orders = {
        "ui/elements/reader_menu_order",
        "ui/elements/filemanager_menu_order",
    }
    local function removeItem(tbl, target_id)
        if type(tbl) ~= "table" then return end
        for k, v in pairs(tbl) do
            if v == target_id then
                table.remove(tbl, k)
                return
            elseif type(v) == "table" then
                removeItem(v, target_id)
            end
        end
    end

    for _, order_path in ipairs(menu_orders) do
        local ok, order = pcall(require, order_path)
        if ok and type(order) == "table" and type(order.tools) == "table" then
            removeItem(order, "sink_sync")
            table.insert(order.tools, 1, "sink_sync")
        end
    end
end

function Sink:addToMainMenu(menu_items)
    injectSinkIntoToolsMenu()
    menu_items.sink_sync = {
        sorting_hint = "tools",
        text = _("Sink"),
        sub_item_table = self:getMenuTable(),
    }
end

function Sink:getMenuTable()
    local is_paired = self.settings.username and self.settings.username ~= ""

    return {
        -- 1. Primary Action: Instant Sync
        {
            text = _("Sync Progress Now"),
            enabled_func = function()
                return self.settings.username ~= ""
            end,
            keep_menu_open = false,
            callback = function()
                NetworkMgr:runWhenOnline(function()
                    UIManager:show(Notification:new{ text = _("Syncing with Sink server...") })
                    self:_syncDocument(true)
                end)
            end,
        },

        -- 2. Daily Reading Toggle: Auto-Sync
        {
            text = _("Auto-Sync on Read / Close / Sleep"),
            checked_func = function()
                return self.settings.auto_sync
            end,
            callback = function()
                self.settings.auto_sync = not self.settings.auto_sync
                self:saveSettings()
            end,
            separator = true,
        },

        -- 3. Live Account & Connection Status
        {
            text_func = function()
                if self.settings.username and self.settings.username ~= "" then
                    return string.format(_("Account: Paired (%s)"), self.settings.username)
                else
                    return _("Account: Not Paired (Tap to pair)")
                end
            end,
            keep_menu_open = true,
            callback = function(touch_menu_instance)
                if self.settings.username ~= "" then
                    NetworkMgr:runWhenOnline(function()
                        self:testConnection()
                    end)
                else
                    if SinkPairing then
                        SinkPairing:startPairing(self, function()
                            self:_syncDocument(false)
                            if touch_menu_instance and touch_menu_instance.updateItems then
                                pcall(function() touch_menu_instance:updateItems() end)
                            end
                        end)
                    end
                end
            end,
        },

        -- 4. Device Setup / Pairing Action
        {
            text_func = function()
                if self.settings.username and self.settings.username ~= "" then
                    return _("Re-Pair Device (Phone / PC)")
                else
                    return _("Pair Device (Phone / PC)")
                end
            end,
            keep_menu_open = false,
            callback = function(touch_menu_instance)
                if SinkPairing then
                    SinkPairing:startPairing(self, function()
                        self:_syncDocument(false)
                        if touch_menu_instance and touch_menu_instance.updateItems then
                            pcall(function() touch_menu_instance:updateItems() end)
                        end
                    end)
                else
                    UIManager:show(InfoMessage:new{ text = _("Pairing module not available.") })
                end
            end,
        },

        -- 5. Server URL Configuration
        {
            text_func = function()
                local url = self.settings.server_url or ""
                local display = url:gsub("^https?://", "")
                if #display > 28 then
                    display = display:sub(1, 25) .. "..."
                end
                return string.format(_("Server: %s"), display)
            end,
            keep_menu_open = true,
            callback = function(touch_menu_instance)
                self:showInputDialog(_("Server URL"), self.settings.server_url, function(val)
                    self.settings.server_url = cleanUrl(val)
                    self:saveSettings()
                    if touch_menu_instance and touch_menu_instance.updateItems then
                        pcall(function() touch_menu_instance:updateItems() end)
                    end
                end)
            end,
        },

        -- 6. Unlink / Reset Option
        {
            text = _("Unlink Device / Clear Account"),
            enabled_func = function()
                return self.settings.username ~= ""
            end,
            keep_menu_open = true,
            callback = function(touch_menu_instance)
                self.settings.username = ""
                self.settings.userkey = ""
                self:saveSettings()
                if touch_menu_instance and touch_menu_instance.updateItems then
                    pcall(function() touch_menu_instance:updateItems() end)
                end
                UIManager:show(Notification:new{ text = _("Device unlinked.") })
            end,
        },
    }
end

function Sink:showInputDialog(title, initial_value, on_confirm)
    local dialog
    dialog = InputDialog:new{
        title = title,
        input = initial_value or "",
        save_callback = function(val)
            if on_confirm then on_confirm(val) end
        end,
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

function Sink:testConnection()
    UIManager:show(Notification:new{ text = _("Checking connection to Sink server...") })
    local res, err = self:_makeRequest("GET", "/users/auth")
    if err or not res then
        UIManager:show(InfoMessage:new{
            text = _("Connection failed:\n") .. tostring(err or "Unknown error"),
        })
        return
    end

    if res.status == 200 then
        UIManager:show(InfoMessage:new{
            text = _("✓ Connected & Synced!\nAccount: ") .. tostring(self.settings.username),
        })
    elseif res.status == 401 then
        UIManager:show(InfoMessage:new{
            text = _("Authentication failed (401 Unauthorized).\nTap 'Pair Device' to re-link your e-reader."),
        })
    else
        UIManager:show(InfoMessage:new{
            text = string.format(_("Server returned HTTP %d:\n%s"), res.status, tostring(res.raw or "")),
        })
    end
end

return Sink
