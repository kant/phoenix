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
 * DOMAgent constructs and maintains a tree of {DOMNode}s that represents the
 * rendered DOM tree in the remote browser. Nodes can be accessed by id or
 * location (source offset). To update the DOM tree in response to a change of
 * the source document (replace [from,to] with text) call
 * `applyChange(from, to, text)`.
 *
 * The DOMAgent triggers `getDocument` once it has loaded
 * the document.
 */
define(function DOMAgent(require, exports, module) {


    var Inspector       = require("LiveDevelopment/Inspector/Inspector"),
        EventDispatcher = require("utils/EventDispatcher"),
        EditAgent       = require("LiveDevelopment/Agents/EditAgent"),
        DOMNode         = require("LiveDevelopment/Agents/DOMNode"),
        DOMHelpers      = require("LiveDevelopment/Agents/DOMHelpers");

    var _load; // {$.Deferred} load promise
    var _idToNode; // {nodeId -> node}
    var _pendingRequests; // {integer} number of pending requests before initial loading is complete

    /** Get the last node before the given location
     * @param {integer} location
     */
    function nodeBeforeLocation(location) {
        var node;
        exports.root.each(function each(n) {
            if (!n.location || location < n.location) {
                return true;
            }
            if (!node || node.location < n.location) {
                node = n;
            }
        });
        return node;
    }

    /** Get the element node that encloses the given location
     * @param {location}
     */
    function allNodesAtLocation(location) {
        var nodes = [];
        exports.root.each(function each(n) {
            if (n.type === DOMNode.TYPE_ELEMENT && n.isAtLocation(location)) {
                nodes.push(n);
            }
        });
        return nodes;
    }

    /** Get the node at the given location
     * @param {location}
     */
    function nodeAtLocation(location) {
        return exports.root.find(function each(n) {
            return n.isAtLocation(location, false);
        });
    }

    /** Find the node for the given id
     * @param {DOMNode} node
     */
    function nodeWithId(nodeId) {
        return _idToNode[nodeId];
    }

    /** Update the node index
     * @param {DOMNode} node
     */
    function removeNode(node) {
        if (node.nodeId) {
            delete _idToNode[node.nodeId];
        }
    }

    /** Update the node index
     * @param {DOMNode} node
     */
    function addNode(node) {
        if (node.nodeId) {
            _idToNode[node.nodeId] = node;
        }
    }

    /** Request the child nodes for a node
     * @param {DOMNode} node
     */
    function requestChildNodes(node) {
        if (_pendingRequests >= 0) {
            _pendingRequests++;
        }
        Inspector.DOM.requestChildNodes(node.nodeId);
    }

    /** Eliminate the query string from a URL
     * @param {string} URL
     */
    function _cleanURL(url) {
        var index = url.search(/[#\?]/);
        if (index >= 0) {
            url = url.substr(0, index);
        }
        return url;
    }

    /** Map the DOM document to the source text
     * @param {string} source
     */
    function _mapDocumentToSource(source) {
        var node = exports.root;
        DOMHelpers.eachNode(source, function each(payload) {
            if (!node) {
                return true;
            }
            if (payload.closing) {
                var parent = node.findParentForNextNodeMatchingPayload(payload);
                if (!parent) {
                    return console.warn("Matching Parent not at " + payload.sourceOffset + " (" + payload.nodeName + ")");
                }
                parent.closeLocation = payload.sourceOffset;
                parent.closeLength = payload.sourceLength;
            } else {
                var next = node.findNextNodeMatchingPayload(payload);
                if (!next) {
                    return console.warn("Skipping Source Node at " + payload.sourceOffset);
                }
                node = next;
                node.location = payload.sourceOffset;
                node.length = payload.sourceLength;
                if (payload.closed) {
                    node.closed = payload.closed;
                }
            }
        });
    }

    /** Load the source document and match it with the DOM tree*/
    function _onFinishedLoadingDOM() {
        var request = new XMLHttpRequest();
        request.open("GET", exports.url);
        request.onload = function onLoad() {
            if ((request.status >= 200 && request.status < 300) ||
                    request.status === 304 || request.status === 0) {
                _mapDocumentToSource(request.response);
                _load.resolve();
            } else {
                var msg = "Received status " + request.status + " from XMLHttpRequest while attempting to load source file at " + exports.url;
                _load.reject(msg, { message: msg });
            }
        };
        request.onerror = function onError() {
            var msg = "Could not load source file at " + exports.url;
            _load.reject(msg, { message: msg });
        };
        request.send(null);
    }

    // WebInspector Event: Page.loadEventFired
    function _onLoadEventFired(event, res) {
        // res = {timestamp}
        Inspector.DOM.getDocument(function onGetDocument(res) {
            exports.trigger("getDocument", res);
            // res = {root}
            _idToNode = {};
            _pendingRequests = 0;
            exports.root = new DOMNode(exports, res.root);
        });
    }

    // WebInspector Event: Page.frameNavigated
    function _onFrameNavigated(event, res) {
        // res = {frame}
        if (!res.frame.parentId) {
            exports.url = _cleanURL(res.frame.url);
        }
    }

     // WebInspector Event: DOM.documentUpdated
    function _onDocumentUpdated(event, res) {
        // res = {}
    }

    // WebInspector Event: DOM.setChildNodes
    function _onSetChildNodes(event, res) {
        // res = {parentId, nodes}
        var node = nodeWithId(res.parentId);
        node.setChildrenPayload(res.nodes);
        if (_pendingRequests > 0 && --_pendingRequests === 0) {
            _onFinishedLoadingDOM();
        }
    }

    // WebInspector Event: DOM.childNodeCountUpdated
    function _onChildNodeCountUpdated(event, res) {
        // res = {nodeId, childNodeCount}
        if (res.nodeId > 0) {
            Inspector.DOM.requestChildNodes(res.nodeId);
        }
    }

    // WebInspector Event: DOM.childNodeInserted
    function _onChildNodeInserted(event, res) {
        // res = {parentNodeId, previousNodeId, node}
        if (res.node.nodeId > 0) {
            var parent = nodeWithId(res.parentNodeId);
            var previousNode = nodeWithId(res.previousNodeId);
            var node = new DOMNode(exports, res.node);
            parent.insertChildAfter(node, previousNode);
        }
    }

    // WebInspector Event: DOM.childNodeRemoved
    function _onChildNodeRemoved(event, res) {
        // res = {parentNodeId, nodeId}
        if (res.nodeId > 0) {
            var node = nodeWithId(res.nodeId);
            node.remove();
        }
    }

    /** Apply a change
     * @param {integer} start offset of the change
     * @param {integer} end offset of the change
     * @param {string} change text
     */
    function applyChange(from, to, text) {
        var delta = from - to + text.length;
        var node = nodeAtLocation(from);

        // insert a text node
        if (!node) {
            if (!(/^\s*$/).test(text)) {
                console.warn("Inserting nodes not supported.");
                node = nodeBeforeLocation(from);
            }
        } else if (node.type === 3) {
            // update a text node
            var value = node.value.substr(0, from - node.location);
            value += text;
            value += node.value.substr(to - node.location);
            node.value = value;
            if (!EditAgent.isEditing) {
                // only update the DOM if the change was not caused by the edit agent
                Inspector.DOM.setNodeValue(node.nodeId, node.value);
            }
        } else {
            console.warn("Changing non-text nodes not supported.");
        }

        // adjust the location of all nodes after the change
        if (node) {
            node.length += delta;
            exports.root.each(function each(n) {
                if (n.location > node.location) {
                    n.location += delta;
                }
                if (n.closeLocation !== undefined && n.closeLocation > node.location) {
                    n.closeLocation += delta;
                }
            });
        }
    }

    /** Enable the domain */
    function enable() {
        return Inspector.DOM.enable();
    }

    /** Disable the domain */
    function disable() {
        return Inspector.DOM.disable();
    }


    /** Initialize the agent */
    function load() {
        _load = new $.Deferred();
        Inspector.Page
            .on("frameNavigated.DOMAgent", _onFrameNavigated)
            .on("loadEventFired.DOMAgent", _onLoadEventFired);
        Inspector.DOM
            .on("documentUpdated.DOMAgent", _onDocumentUpdated)
            .on("setChildNodes.DOMAgent", _onSetChildNodes)
            .on("childNodeCountUpdated.DOMAgent", _onChildNodeCountUpdated)
            .on("childNodeInserted.DOMAgent", _onChildNodeInserted)
            .on("childNodeRemoved.DOMAgent", _onChildNodeRemoved);
        return _load.promise();
    }

    /** Clean up */
    function unload() {
        Inspector.Page.off(".DOMAgent");
        Inspector.DOM.off(".DOMAgent");
    }


    EventDispatcher.makeEventDispatcher(exports);

    // Export private functions
    exports.enable = enable;
    exports.disable = disable;
    exports.nodeBeforeLocation = nodeBeforeLocation;
    exports.allNodesAtLocation = allNodesAtLocation;
    exports.nodeAtLocation = nodeAtLocation;
    exports.nodeWithId = nodeWithId;
    exports.removeNode = removeNode;
    exports.addNode = addNode;
    exports.requestChildNodes = requestChildNodes;
    exports.applyChange = applyChange;
    exports.load = load;
    exports.unload = unload;
});
