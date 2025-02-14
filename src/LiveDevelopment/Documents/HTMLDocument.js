/*
 * GNU AGPL-3.0 License
 *
 * Modified Work Copyright (c) 2021 - present core.ai . All rights reserved.
 * Original work Copyright (c) 2012 - 2021 Adobe Systems Incorporated. All rights reserved.
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

/**
 * HTMLDocument manages a single HTML source document
 *
 * __EDITING__
 *
 * Editing the document will cause the corresponding node to be updated
 * by calling `applyChanges` on the DOMAgent. This will only work for
 * altering text nodes and will break when attempting to change DOM elements
 * or inserting or deleting nodes.
 *
 * __HIGHLIGHTING__
 *
 * HTMLDocument supports highlighting nodes from the HighlightAgent and
 * highlighting the DOMNode corresponding to the cursor position in the
 * editor.
 */
define(function HTMLDocumentModule(require, exports, module) {


    var EditorManager       = require("editor/EditorManager"),
        EventDispatcher     = require("utils/EventDispatcher"),
        HighlightAgent      = require("LiveDevelopment/Agents/HighlightAgent"),
        HTMLInstrumentation = require("language/HTMLInstrumentation"),
        Inspector           = require("LiveDevelopment/Inspector/Inspector"),
        LiveDevelopment     = require("LiveDevelopment/LiveDevelopment"),
        PerfUtils           = require("utils/PerfUtils"),
        RemoteAgent         = require("LiveDevelopment/Agents/RemoteAgent"),
        _                   = require("thirdparty/lodash");

    /**
     * @constructor
     * @param {!Document} doc The source document from Brackets
     * @param {!Editor} editor The editor for this document
     */
    var HTMLDocument = function HTMLDocument(doc, editor) {
        this.doc = doc;
        if (this.doc) {
            this.doc.addRef();
        }

        this.editor = editor;
        this._instrumentationEnabled = false;

        this._onActiveEditorChange = this._onActiveEditorChange.bind(this);
        EditorManager.on("activeEditorChange", this._onActiveEditorChange);

        // Attach now
        this.attachToEditor(editor);
    };
    EventDispatcher.makeEventDispatcher(HTMLDocument.prototype);

    /**
     * Enable or disable instrumented HTML
     * @param {boolean} enabled Whether to enable or disable
     */
    HTMLDocument.prototype.setInstrumentationEnabled = function setInstrumentationEnabled(enabled) {
        if (enabled && !this._instrumentationEnabled && this.editor) {
            HTMLInstrumentation.scanDocument(this.doc);
            HTMLInstrumentation._markText(this.editor);
        }

        this._instrumentationEnabled = enabled;
    };

    /**
     * Returns true if document edits appear live in the connected browser
     * @return {boolean}
     */
    HTMLDocument.prototype.isLiveEditingEnabled = function () {
        return this._instrumentationEnabled;
    };

    /**
     * Returns a JSON object with HTTP response overrides
     * @param {boolean} enabled (Unused)
     * @return {{body: string}}
     */
    HTMLDocument.prototype.getResponseData = function getResponseData(enabled) {
        var body;
        if (this._instrumentationEnabled) {
            if (this.editor) {
                body = HTMLInstrumentation.generateInstrumentedHTML(this.editor);
            } else {
                this.doc._ensureMasterEditor();
                body = HTMLInstrumentation.generateInstrumentedHTML(this.doc._masterEditor);
            }
        }

        return {
            body: body || this.doc.getText()
        };
    };

    /**
     * Close the document
     */
    HTMLDocument.prototype.close = function close() {
        if (this.editor) {
            this.editor.off(".HTMLDocument");
        }

        if (this.doc) {
            this.doc.releaseRef();
        }

        EditorManager.off("activeEditorChange", this._onActiveEditorChange);

        // Experimental code
        if (LiveDevelopment.config.experimental) {
            // Force highlight teardown
            this._onHighlight();
        }
    };

    /**
     * Attach new editor
     * @param {!Editor} editor The editor for this document
     */
    HTMLDocument.prototype.attachToEditor = function (editor) {
        var self = this;
        this.editor = editor;

        // Performance optimization to use closures instead of Function.bind()
        // to improve responsiveness during cursor movement and keyboard events
        this.editor.on("cursorActivity.HTMLDocument", function (event, editor) {
            self._onCursorActivity(event, editor);
        });

        this.editor.on("change.HTMLDocument", function (event, editor, change) {
            self._onChange(event, editor, change);
        });

        this.editor.on("beforeDestroy.HTMLDocument", function (event, editor) {
            self._onDestroy(event, editor);
        });

        // Experimental code
        if (LiveDevelopment.config.experimental) {
            HighlightAgent.on("highlight.HTMLDocument", function (event, node) {
                self._onHighlight(event, node);
            });
        }

        if (this._instrumentationEnabled) {
            // Resync instrumentation with editor
            HTMLInstrumentation._markText(this.editor);
        }
    };

    /**
     * Detach current editor
     */
    HTMLDocument.prototype.detachFromEditor = function () {
        if (this.editor) {
            HighlightAgent.hide();
            this.editor.off(".HTMLDocument");
            this._removeHighlight();
            this.editor = null;
        }
    };

    /**
     * Update the highlight
     */
    HTMLDocument.prototype.updateHighlight = function () {
        var editor = this.editor,
            ids = [];

        if (Inspector.config.highlight) {
            if (editor) {
                _.each(editor.getSelections(), function (sel) {
                    var tagID = HTMLInstrumentation._getTagIDAtDocumentPos(
                        editor,
                        sel.reversed ? sel.end : sel.start
                    );
                    if (tagID !== -1) {
                        ids.push(tagID);
                    }
                });
            }

            if (!ids.length) {
                HighlightAgent.hide();
            } else {
                HighlightAgent.domElement(ids);
            }
        }
    };

    /** Event Handlers *******************************************************/

    /**
     * Triggered on cursor activity by the editor
     * @param {$.Event} event Event
     * @param {!Editor} editor The editor for this document
     */
    HTMLDocument.prototype._onCursorActivity = function (event, editor) {
        if (this.editor !== editor) {
            return;
        }
        this.updateHighlight();
    };

    /**
     * @private
     * For the given editor change, compare the resulting browser DOM with the
     * in-editor DOM. If there are any diffs, a warning is logged to the
     * console along with each diff.
     * @param {Object} change CodeMirror editor change data
     */
    HTMLDocument.prototype._compareWithBrowser = function (change) {
        var self = this;

        RemoteAgent.call("getSimpleDOM").done(function (res) {
            var browserSimpleDOM = JSON.parse(res.result.value),
                edits,
                node,
                result;

            try {
                result = HTMLInstrumentation._getBrowserDiff(self.editor, browserSimpleDOM);
            } catch (err) {
                console.error("Error comparing in-browser DOM to in-editor DOM");
                console.error(err.stack);
                return;
            }

            edits = result.diff.filter(function (delta) {
                // ignore textDelete in html root element
                node = result.browser.nodeMap[delta.parentID];

                if (node && node.tag === "html" && delta.type === "textDelete") {
                    return false;
                }

                return true;
            });

            if (edits.length > 0) {
                console.warn("Browser DOM does not match after change: " + JSON.stringify(change));

                edits.forEach(function (delta) {
                    console.log(delta);
                });
            }
        });
    };

    /**
     * Triggered when the editor is being destroyed
     * @param {$.Event} event Event
     * @param {!Editor} editor The editor being destroyed
     */
    HTMLDocument.prototype._onDestroy = function (event, editor) {
        if (this.editor === editor) {
            this.detachFromEditor();
        }
    };


    /**
     * Triggered on change by the editor
     * @param {$.Event} event Event
     * @param {!Editor} editor The editor for this document
     * @param {Object} change CodeMirror editor change data
     */
    HTMLDocument.prototype._onChange = function (event, editor, change) {
        // Make sure LiveHTML is turned on
        if (!this._instrumentationEnabled) {
            return;
        }

        // Apply DOM edits is async, so previous PerfUtils timer may still be
        // running. PerfUtils does not support running multiple timers with same
        // name, so do not start another timer in this case.
        var perfTimerName   = "HTMLDocument applyDOMEdits",
            isNestedTimer   = PerfUtils.isActive(perfTimerName);
        if (!isNestedTimer) {
            PerfUtils.markStart(perfTimerName);
        }

        // Only handles attribute changes currently.
        // TODO: text changes should be easy to add
        // TODO: if new tags are added, need to instrument them
        var self                = this,
            result              = HTMLInstrumentation.getUnappliedEditList(editor, change),
            applyEditsPromise;

        if (result.edits) {
            applyEditsPromise = RemoteAgent.call("applyDOMEdits", result.edits);

            applyEditsPromise.always(function () {
                if (!isNestedTimer) {
                    PerfUtils.addMeasurement(perfTimerName);
                }
            });
        }

        this.errors = result.errors || [];
        this.trigger("statusChanged", this);

        // Debug-only: compare in-memory vs. in-browser DOM
        // edit this file or set a conditional breakpoint at the top of this function:
        //     "this._debug = true, false"
        if (this._debug) {
            console.log("Edits applied to browser were:");
            console.log(JSON.stringify(result.edits, null, 2));
            applyEditsPromise.done(function () {
                self._compareWithBrowser(change);
            });
        }

//        var marker = HTMLInstrumentation._getMarkerAtDocumentPos(
//            this.editor,
//            editor.getCursorPos()
//        );
//
//        if (marker && marker.tagID) {
//            var range   = marker.find(),
//                text    = marker.doc.getRange(range.from, range.to);
//
//            // HACK maintain ID
//            text = text.replace(">", " data-brackets-id='" + marker.tagID + "'>");
//
//            // FIXME incorrectly replaces body elements with content only, missing body element
//            RemoteAgent.remoteElement(marker.tagID).replaceWith(text);
//        }

        // if (!this.editor) {
        //     return;
        // }
        // var codeMirror = this.editor._codeMirror;
        // while (change) {
        //     var from = codeMirror.indexFromPos(change.from);
        //     var to = codeMirror.indexFromPos(change.to);
        //     var text = change.text.join("\n");
        //     DOMAgent.applyChange(from, to, text);
        //     change = change.next;
        // }
    };

    /**
     * Triggered when the active editor changes
     * @param {$.Event} event Event
     * @param {!Editor} newActive The new active editor
     * @param {!Editor} oldActive The old active editor
     */
    HTMLDocument.prototype._onActiveEditorChange = function (event, newActive, oldActive) {
        this.detachFromEditor();

        if (newActive && newActive.document === this.doc) {
            this.attachToEditor(newActive);
        }
    };

    /**
     * Triggered by the HighlightAgent to highlight a node in the editor
     * @param {$.Event} event Event
     * @param {DOMElement} node Element to highlight
     */
    HTMLDocument.prototype._onHighlight = function (event, node) {
        this._removeHighlight();
        if (!node || !node.location || !this.editor) {
            return;
        }

        var codeMirror = this.editor._codeMirror;
        var to, from = codeMirror.posFromIndex(node.location);
        if (node.closeLocation) {
            to = node.closeLocation + node.closeLength;
        } else {
            to = node.location + node.length;
        }

        to = codeMirror.posFromIndex(to);
        this._highlight = codeMirror.markText(from, to, { className: "highlight" });
    };

    /**
     * Remove all highlighting
     */
    HTMLDocument.prototype._removeHighlight = function () {
        if (this._highlight) {
            this._highlight.clear();
            this._highlight = null;
        }
    };

    // Export the class
    module.exports = HTMLDocument;
});
