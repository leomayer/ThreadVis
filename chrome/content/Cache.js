/** ****************************************************************************
 * Cache.js
 *
 * (c) 2007 Alexander C. Hubmann
 * (c) 2007 Alexander C. Hubmann-Haidvogel
 *
 * Implements cache for threaded messages
 * Store message ids of thread via setStringProperty in msf file
 *
 * $Id$
 ******************************************************************************/
function Cache(threadvis) {
    this.threadvis = threadvis;
    this.visitedMsgIds = new Object();
    this.cacheBuildCount = 0;
    this.updatingCache = false;
    this.newMessages = new Array();
}



/** ****************************************************************************
 * Get cache string for message
 * Read X-ThreadVis-Cache
 ******************************************************************************/
Cache.prototype.getCache = function(msg) {
    this.visitedMsgIds = new Object();
    var cache = this.getCacheInternal(msg);
    this.threadvis.getThreader().thread();
    return cache;
}



/** ****************************************************************************
 * Get cache string for message (internal)
 ******************************************************************************/
Cache.prototype.getCacheInternal = function(msg) {
    if (this.visitedMsgIds[msg.messageId] == true) {
        return;
    }
    this.visitedMsgIds[msg.messageId] = true;
    var cache = "";
    cache = msg.getStringProperty("X-ThreadVis-Cache");
    if (cache != "") {
        this.addToThreaderFromCache(cache);
    } else {
        //this.addToThreaderFromReferences(msg);
    }
    return cache;
}



/** ****************************************************************************
 * Add all messages from references to threader
 ******************************************************************************/
Cache.prototype.addToThreaderFromReferences = function(msg) {
    this.threadvis.addMessage(msg);
    var references = (new References(msg.getStringProperty("references")))
        .getReferences();
    for (var i = 0; i < references.length; i++) {
        var ref = references[i];
        var refMessage = this.searchMessageByMsgId(ref);
        if (refMessage) {
            this.getCacheInternal(refMessage);
        }
    }
}



/** ****************************************************************************
 * Get cache string for container, store for all messages in thread
 ******************************************************************************/
Cache.prototype.updateCache = function(container) {
    var topcontainer = container.getTopContainer();
    var cache = topcontainer.getCache();
    cache = "[" + cache + "]";
    this.putCache(topcontainer, cache);
}



/** ****************************************************************************
 * Recursivly put cache string in all messages
 ******************************************************************************/
Cache.prototype.putCache = function(container, cache) {
    if (! container.isDummy()) {
        var msgid = container.getMessage().getId();
        var msg = this.searchMessageByMsgId(msgid);
        msg.setStringProperty("X-ThreadVis-Cache", cache);
    }

    var child = null;
    for (child = container.getChild(); child != null; child = child.getNext()) {
        this.putCache(child, cache);
    }
}



/** ****************************************************************************
 * Add all messages from cache to threader
 ******************************************************************************/
Cache.prototype.addToThreaderFromCache = function(cache) {
    var elements = eval('(' + cache + ')');

    for (var i = 0; i < elements.length; i++) {
        var msgid = elements[i];
        var msg = this.searchMessageByMsgId(msgid);
        if (msg != null) {
            this.threadvis.addMessage(msg);
        }
    }
}



/** ****************************************************************************
 * Search for message id in current account
 ******************************************************************************/
Cache.prototype.searchMessageByMsgId = function(messageId) {
    return this.searchInSubFolder(this.threadvis.rootFolder, messageId);
}



/** ****************************************************************************
 * Search for message id in subfolder
 ******************************************************************************/
Cache.prototype.searchInSubFolder = function(folder, messageId) {
    if (folder.hasSubFolders) {
        var subfolders = folder.GetSubFolders();
        var subfolder = null;
        var msgHdr = null;
        var msgDB = null;
        var currentFolderURI = "";

        var done = false;
        while(!done) {
            currentFolderURI = subfolders.currentItem()
                .QueryInterface(Components.interfaces.nsIRDFResource).Value;
            subfolder = GetMsgFolderFromUri(currentFolderURI);

            if (currentFolderURI.substring(1,7) != "news://") {
                msgHdr = this.searchInSubFolder(subfolder, messageId);
            }

            if (!msgHdr) {
                try {
                    msgDB = subfolder.getMsgDatabase(msgWindow);
                } catch (ex) {
                    subfolder.updateFolder(msgWindow);
                    msgDB = subfolder.getMsgDatabase(msgWindow);
                }
                msgHdr = msgDB.getMsgHdrForMessageID(messageId);
            }

            if (msgHdr) {
                return msgHdr;
            }

            try {
                subfolders.next();
            } catch(e) {
                done = true;
            }
        }
    }
    return null;
}



/** ****************************************************************************
 * Periodically update cache with new messages
 ******************************************************************************/
Cache.prototype.updateNewMessages = function(message, doVisualise) {
    var account = (Components.classes["@mozilla.org/messenger/account-manager;1"]
        .getService(Components.interfaces.nsIMsgAccountManager))
        .FindAccountForServer(message.folder.server);

    this.updateNewMessagesInternal(message, doVisualise, 
        account.key, message.folder.rootFolder);
}



/** ****************************************************************************
 * Periodically update cache with new messages
 * FIXXME: also write cache for all messages!!
 ******************************************************************************/
Cache.prototype.updateNewMessagesInternal = function(message, doVisualise,
    accountKey, rootFolder) {
    // check for already running update
    var ref = this;
    if (this.updatingCache) {
        setTimeout(function() {
                ref.updateNewMessagesInternal(message, doVisualise, accountKey,
                    rootFolder);
            }, 1000);
        return;
    }

    this.updatingCache = true;

    this.threadvis.setStatus(
        this.threadvis.strings.getString("cache.building.start"));
    var searchSession = 
        Components.classes["@mozilla.org/messenger/searchSession;1"]
        .createInstance(Components.interfaces.nsIMsgSearchSession);
    var searchTerm = searchSession.createTerm();
    searchTerm.attrib = Components.interfaces.nsMsgSearchAttrib.Date;
    searchTerm.op = Components.interfaces.nsMsgSearchOp.IsAfter;

    var termValue = searchTerm.value;
    termValue.attrib = searchTerm.attrib;

    // get last update timestamp from preferences
    var updateTimestamp = this.getLastUpdateTimestamp(accountKey);

    termValue.date = updateTimestamp;
    searchTerm.value = termValue;

    searchSession.appendTerm(searchTerm);
    this.addSubFolders(searchSession, rootFolder);

    var newUpdateTimestamp = (new Date()).getTime() * 1000;
    var ref = this;
    var count = 0;
    searchSession.registerListener({
        onNewSearch: function() {
            ref.cacheBuildCount++;
        },
        onSearchDone: function(status) {
            ref.threadvis.setStatus("");
            ref.setLastUpdateTimestamp(accountKey, newUpdateTimestamp);

            ref.threadvis.threader.thread();
            var container = ref.threadvis.getThreader()
                .findContainer(message.messageId);

            if (container) {
                if (container.isDummy()) {
                    // current message still not found
                    // somehow it is not cached altough it should have been
                    // reset last update timestamp to date if this message
                    ref.threadvis.setStatus(
                        ref.threadvis.strings.getString("cache.error"));

                    // set last update timestamp just before this message
                    var messageUpdateTimestamp = message.date - 1;

                    // if we already tried to build cache for this message
                    // reset to 0 just in case
                    if (ref.cacheBuildCount > 1) {
                        messageUpdateTimestamp = 0;
                    }
                    ref.setLastUpdateTimestamp(accountKey,
                        messageUpdateTimestamp);

                    ref.updatingCache = false;
                    ref.updateNewMessagesInternal(message, doVisualise,
                        accountKey, rootFolder);
                    return;
                }

                ref.updateNewMessagesWriteCache();

                ref.cacheBuildCount = 0;
                ref.updatingCache = false;
                if (doVisualise) {
                    ref.threadvis.visualiseMessage(message);
                }
            } else {
                // current message still not found
                // somehow it is not cached altough it should have been
                // reset last update timestamp to date if this message
                ref.threadvis.setStatus(
                    ref.threadvis.strings.getString("cache.error"));

                // set last update timestamp just before this message
                var messageUpdateTimestamp = message.date - 1;

                // if we already tried to build cache for this message
                // reset to 0 just in case
                if (ref.cacheBuildCount > 1) {
                    messageUpdateTimestamp = 0;
                }

                ref.updatingCache = false;
                ref.setLastUpdateTimestamp(accountKey, messageUpdateTimestamp);
                ref.updateNewMessagesInternal(message, doVisualise, accountKey,
                    rootFolder);
            }
        },
        onSearchHit: function(header, folder) {
            ref.threadvis.setStatus(
                ref.threadvis.strings.getString("cache.building.status") + count);
            ref.threadvis.addMessage(header);
            count++;
            ref.newMessages.push(header);
        }
    });

    searchSession.search(null);
}



/** ****************************************************************************
 * Get the last update timestamp for the given account
 ******************************************************************************/
Cache.prototype.getLastUpdateTimestamp = function(accountKey) {
    var pref = this.threadvis.preferences.getPreference(
        this.threadvis.preferences.PREF_CACHE_LASTUPDATETIMESTAMP);
    var entries = pref.split(",");
    var timestamps = new Object();
    for (var key in entries) {
        var entry = entries[key];
        if (entry) {
            var splits = entry.split("=");
            timestamps[splits[0]] = splits[1];
        }
    }
    if (timestamps[accountKey]) {
        return timestamps[accountKey];
    } else {
        return 0;
    }
}



/** ****************************************************************************
 * Set the last update timestamp for the given account
 ******************************************************************************/
Cache.prototype.setLastUpdateTimestamp = function(accountKey, timestamp) {
    var pref = this.threadvis.preferences.getPreference(
        this.threadvis.preferences.PREF_CACHE_LASTUPDATETIMESTAMP);
    var entries = pref.split(",");
    var timestamps = new Object();
    for (var key in entries) {
        var entry = entries[key];
        var splits = entry.split("=");
        timestamps[splits[0]] = splits[1];
    }
    timestamps[accountKey] = timestamp;

    var output = "";
    for (var key in timestamps) {
        if (key) {
            output += key + "=" + timestamps[key] + ",";
        }
    }

    output = output.substring(0, output.length - 1);
    this.threadvis.preferences.setPreference(
        this.threadvis.preferences.PREF_CACHE_LASTUPDATETIMESTAMP,
        output, this.threadvis.preferences.PREF_STRING);
}



/** ****************************************************************************
 * Add all subfolders of account to searchquery
 ******************************************************************************/
Cache.prototype.addSubFolders = function(searchSession, folder) {
    if (folder.hasSubFolders) {
        var subFolderEnumerator = folder.GetSubFolders();
        var done = false;
        while (! done) {
            var next = subFolderEnumerator.currentItem();
            if (next) {
                var nextFolder = next.QueryInterface(
                    Components.interfaces.nsIMsgFolder);
                if (nextFolder && ! (nextFolder.flags 
                    & MSG_FOLDER_FLAG_VIRTUAL)) {
                    if (!nextFolder.noSelect &&
                        this.threadvis.checkEnabledAccountOrFolder(nextFolder)) {
                        var searchScope = nextFolder.server.searchScope;
                        searchSession.addScopeTerm(searchScope, nextFolder);
                        // ??? FIXME
                        // newsgroups messages are only found when using localNews
                        if (searchScope == nsMsgSearchScope.news) {
                            searchSession.addScopeTerm(nsMsgSearchScope.localNews,
                                nextFolder);
                        }
                    }
                    this.addSubFolders(searchSession, nextFolder);
                }
            }
            try {
                subFolderEnumerator.next();
            } catch (ex) {
                done = true;
            }
        }
    }
}



/** ****************************************************************************
 * Reset all caches for all messages in account
 ******************************************************************************/
Cache.prototype.reset = function(key) {
    // get account for key
    var accountManager = Components
        .classes["@mozilla.org/messenger/account-manager;1"]
        .getService(Components.interfaces.nsIMsgAccountManager);
    var account = accountManager.getAccount(key)

    var counter = 0;
    if (account instanceof Components.interfaces.nsIMsgAccount) {
        // reset update timestamp
        this.setLastUpdateTimestamp(account.key, 0);

        // reset all caches for all messages
        var rootFolder = account.incomingServer.rootFolder;
        var folders = this.resetGetAllFolders(rootFolder);
        for (var j = 0; j < folders.length; j++) {
            counter = this.resetAllMessages(folders[j], counter);
        }
    }
}



/** ****************************************************************************
 * Get all subfolders starting from "folder" as array
 ******************************************************************************/
Cache.prototype.resetGetAllFolders = function(folder) {
    var folderEnumerator = folder.GetSubFolders();
    var currentFolder = null;
    var folders = new Array();

    while (true) {
        try {
            currentFolder = folderEnumerator.currentItem();
        } catch (Exception) {
            break;
        }

        if (currentFolder instanceof Components.interfaces.nsIMsgFolder) {
            if (! (currentFolder.flags & MSG_FOLDER_FLAG_VIRTUAL)) {
                folders.push(currentFolder);
            }
        }

        if (currentFolder.hasSubFolders) {
            folders.concat(this.resetGetAllFolders(currentFolder));
        }

        try {
            folderEnumerator.next();
        } catch (Exception) {
            break;
        }
    }
    return folders;
}



/** ****************************************************************************
 * Reset cache for all messages in folder
 ******************************************************************************/
Cache.prototype.resetAllMessages = function(folder, counter) {
    var enumerator = folder.getMessages(null);
    while (enumerator.hasMoreElements()) {
        var header = enumerator.getNext();
        if (header instanceof Components.interfaces.nsIMsgDBHdr) {
            counter++;
            this.threadvis.setStatus(
                this.threadvis.strings.getString("cache.reset.status") + counter);
            header.setStringProperty("X-ThreadVis-Cache", "");
        }
    }
    return counter;
}


/** ****************************************************************************
 * Write cache to disk for all new messages
 ******************************************************************************/
Cache.prototype.updateNewMessagesWriteCache = function() {
    var util = new Util();
    var ref = this;
    util.registerListener({
        onItem: function(item, count, remaining) {
            var container = ref.threadvis.getThreader().findContainer(item.messageId);
            ref.threadvis.setStatus(
                ref.threadvis.strings.getString("cache.update.status") + count + " [" + remaining + "]");
            if (container.isTopContainer()) {
                ref.updateCache(container);
            }
        },
        onFinished: function() {
            ref.threadvis.setStatus("Cache done");
        }
    });
    util.do(this.newMessages);
}



function Util() {
    var listener = null;
    this.count = 0;
}

Util.prototype.registerListener = function(listener) {
    this.listener = listener;
}

Util.prototype.do = function(array) {
    var elem = array.pop();
    var remaining = array.length;
    var ref = this;
    if (elem) {
        this.count++;
        this.listener.onItem(elem, this.count, remaining);
        setTimeout(function() {ref.do(array);}, 1);
    } else {
        this.listener.onFinished();
    }
}