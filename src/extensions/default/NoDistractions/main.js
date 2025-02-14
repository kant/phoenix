/*
 * GNU AGPL-3.0 License
 *
 * Modified Work Copyright (c) 2021 - present core.ai . All rights reserved.
 * Original work Copyright (c) 2015 - 2021 Adobe Systems Incorporated. All rights reserved.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see https://opensource.org/licenses/AGPL-3.0.
 *
 */

define(function (require, exports, module) {


    var Menus               = brackets.getModule("command/Menus"),
        CommandManager      = brackets.getModule("command/CommandManager"),
        Commands            = brackets.getModule("command/Commands"),
        Strings             = brackets.getModule("strings"),
        PreferencesManager  = brackets.getModule("preferences/PreferencesManager"),
        ViewUtils           = brackets.getModule("utils/ViewUtils"),
        KeyBindingManager   = brackets.getModule("command/KeyBindingManager"),
        HealthLogger        = brackets.getModule("utils/HealthLogger"),
        WorkspaceManager    = brackets.getModule("view/WorkspaceManager");

    // Constants
    var PREFS_PURE_CODE           = "noDistractions",
        CMD_TOGGLE_PURE_CODE      = "view.togglePureCode",
        CMD_TOGGLE_PANELS         = "view.togglePanels",
        HEALTH_NO_DISTRACTION     = "noDistractionModeUsed",
        HEALTH_TOGGLE_PANELS      = "togglePanels";

    //key binding keys
    var togglePureCodeKey         = "Ctrl-Shift-2",
        togglePureCodeKeyMac      = "Cmd-Shift-2",
        togglePanelsKey           = "Ctrl-Shift-1",
        togglePanelsKeyMac        = "Cmd-Shift-1",
        togglePanelsKey_EN        = "Ctrl-Shift-`",
        togglePanelsKeyMac_EN     = "Cmd-Shift-`";

    //locals
    var _previouslyOpenPanelIDs = [],
        panelsToggled = false,
        layoutUpdated = false;

    /**
     * @private
     * Updates the command checked status based on the preference for noDestraction mode
     */
    function _updateCheckedState() {
        CommandManager.get(CMD_TOGGLE_PURE_CODE).setChecked(PreferencesManager.get(PREFS_PURE_CODE));
    }

    /**
     * @private
     * toggles noDisraction preference
     */
    function _togglePureCode() {
        PreferencesManager.set(PREFS_PURE_CODE, !PreferencesManager.get(PREFS_PURE_CODE));
        HealthLogger.setHealthDataLog(HEALTH_NO_DISTRACTION, true);
    }

    /**
     * hide all open panels
     */
    function _hidePanelsIfRequired() {
        var panelIDs = WorkspaceManager.getAllPanelIDs();
        _previouslyOpenPanelIDs = [];
        panelIDs.forEach(function (panelID) {
            var panel = WorkspaceManager.getPanelForID(panelID);
            if (panel && panel.isVisible()) {
                panel.hide();
                _previouslyOpenPanelIDs.push(panelID);
            }
        });
    }

    /**
     * show all open panels that was previously hidden by _hidePanelsIfRequired()
     */
    function _showPanelsIfRequired() {
        var panelIDs = _previouslyOpenPanelIDs;
        panelIDs.forEach(function (panelID) {
            var panel = WorkspaceManager.getPanelForID(panelID);
            if (panel) {
                panel.show();
            }
        });
        _previouslyOpenPanelIDs = [];
    }

    function _updateLayout() {
        layoutUpdated = true;
        panelsToggled = false;
    }

    /**
     * We toggle panels in certain cases only :
     * 1. if a panel is shown, toggle can hide it, and successive toggle can show the panel and repeat.
     * 2. if a panel is hidden by toggle, and say the workspace changed making another panel visible by some operation;
     * we reset toggle states so that toggle would hide the panel already present in the workspace.
     * The already hidden panel should not be shown in the specific case for better UX.
     */
    function _togglePanels() {
        var togglePanelCount;
        panelsToggled = !panelsToggled;
        if (panelsToggled) {
            _hidePanelsIfRequired();
            layoutUpdated = false;
            panelsToggled = true;
        } else if (!layoutUpdated) {
            _showPanelsIfRequired();
        }

        //log health data
        togglePanelCount = HealthLogger.getHealthDataLog(HEALTH_TOGGLE_PANELS);
        togglePanelCount = (typeof togglePanelCount === 'number') ? togglePanelCount + 1 : 0;
        HealthLogger.setHealthDataLog(HEALTH_TOGGLE_PANELS, togglePanelCount);
    }

    PreferencesManager.definePreference(PREFS_PURE_CODE, "boolean", false, {
        description: Strings.DESCRIPTION_PURE_CODING_SURFACE
    });

    PreferencesManager.on("change", PREFS_PURE_CODE, function () {
        if (PreferencesManager.get(PREFS_PURE_CODE)) {
            ViewUtils.hideMainToolBar();
            CommandManager.execute(Commands.HIDE_SIDEBAR);
            _hidePanelsIfRequired();
        } else {
            ViewUtils.showMainToolBar();
            CommandManager.execute(Commands.SHOW_SIDEBAR);
            _showPanelsIfRequired();
        }
        _updateCheckedState();
    });

    WorkspaceManager.on(WorkspaceManager.EVENT_WORKSPACE_PANEL_SHOWN, _updateLayout);

    /**
     * Register the Commands , add the Menu Items and key bindings
     */
    function initializeCommands() {
        CommandManager.register(Strings.CMD_TOGGLE_PURE_CODE, CMD_TOGGLE_PURE_CODE, _togglePureCode);
        CommandManager.register(Strings.CMD_TOGGLE_PANELS, CMD_TOGGLE_PANELS, _togglePanels);

        Menus.getMenu(Menus.AppMenuBar.VIEW_MENU).addMenuItem(CMD_TOGGLE_PANELS, "", Menus.AFTER, Commands.VIEW_HIDE_SIDEBAR);
        Menus.getMenu(Menus.AppMenuBar.VIEW_MENU).addMenuItem(CMD_TOGGLE_PURE_CODE, "", Menus.AFTER, CMD_TOGGLE_PANELS);

        KeyBindingManager.addBinding(CMD_TOGGLE_PURE_CODE, [ {key: togglePureCodeKey}, {key: togglePureCodeKeyMac, platform: "mac"} ]);

        //default toggle panel shortcut was ctrl+shift+` as it is present in one vertical line in the keyboard. However, we later learnt
        //from IQE team than non-English keyboards does not have the ` char. So added one more shortcut ctrl+shift+1 which will be preferred
        KeyBindingManager.addBinding(CMD_TOGGLE_PANELS, [ {key: togglePanelsKey}, {key: togglePanelsKeyMac, platform: "mac"} ]);
        KeyBindingManager.addBinding(CMD_TOGGLE_PANELS, [ {key: togglePanelsKey_EN}, {key: togglePanelsKeyMac_EN, platform: "mac"} ]);
    }

    initializeCommands();

});
