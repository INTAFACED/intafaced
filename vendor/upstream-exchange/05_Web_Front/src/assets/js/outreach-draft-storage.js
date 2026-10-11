'use strict';

// Origin-bound opt-in device recovery. Nothing is written to URLs or analytics.
const DATABASE = 'intafaced-enquiry-drafts';
const STORE = 'protected-drafts';
const RECORD = 'current';
function requestResult(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error || new Error('draft_storage_unavailable'));
    };
  });
}
async function openDatabase(indexedDB) {
  let request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = function () {
    request.result.createObjectStore(STORE);
  };
  return requestResult(request);
}
function transaction(database, operation, value) {
  return new Promise(function (resolve, reject) {
    let tx = database.transaction(STORE, operation === 'get' ? 'readonly' : 'readwrite');
    let store = tx.objectStore(STORE),
      result;
    let request = operation === 'get' ? store.get(RECORD) : operation === 'delete' ? store.delete(RECORD) : store.put(value, RECORD);
    request.onsuccess = function () {
      result = request.result;
    };
    tx.oncomplete = function () {
      resolve(result);
    };
    tx.onerror = tx.onabort = function () {
      reject(tx.error || new Error('draft_storage_unavailable'));
    };
  });
}
async function createDraftStorage(options) {
  let database = null,
    key = null,
    remembered = null,
    value = null,
    queue = Promise.resolve(),
    expired = false;
  try {
    value = options.session.getItem(options.storageKey);
  } catch (e) {
    /* Target writes expose unavailable storage. */
  }
  try {
    if (!options.indexedDB || !options.crypto.subtle) throw new Error('draft_storage_unavailable');
    database = await openDatabase(options.indexedDB);
    let envelope = await transaction(database, 'get');
    if (envelope) {
      if (envelope.version !== 1 || (envelope.expiresAt && Date.parse(envelope.expiresAt) <= options.now())) {
        expired = !!envelope.expiresAt && Date.parse(envelope.expiresAt) <= options.now();
        await transaction(database, 'delete');
      } else {
        let decrypted = await options.crypto.subtle.decrypt({ name: 'AES-GCM', iv: envelope.iv }, envelope.key, envelope.ciphertext);
        remembered = new TextDecoder().decode(decrypted);
        key = envelope.key;
        if (!value) value = remembered;
      }
    }
  } catch (e) {
    if (database) {
      try {
        await transaction(database, 'delete');
      } catch (ignored) {}
    }
    database = null;
  }
  return {
    persistentAvailable: !!database,
    expired: expired,
    remembered: !!remembered,
    getItem: function () {
      return value;
    },
    setItem: function (storageKey, next) {
      value = next;
      let snapshot = JSON.parse(next),
        remember = snapshot && snapshot.ui && snapshot.ui.remember === true;
      queue = queue
        .catch(function () {})
        .then(async function () {
          let sessionStored = false;
          try {
            options.session.setItem(storageKey, next);
            sessionStored = true;
          } catch (e) {}
          if (!remember) {
            if (database) await transaction(database, 'delete');
            if (!sessionStored) throw new Error('draft_storage_unavailable');
            return;
          }
          if (!database) throw new Error('draft_storage_unavailable');
          if (!key) key = await options.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
          let iv = options.crypto.getRandomValues(new Uint8Array(12));
          let ciphertext = await options.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(next));
          await transaction(database, 'put', { version: 1, key: key, iv: iv, ciphertext: ciphertext, expiresAt: snapshot.expiresAt });
        });
      return queue;
    },
    removeItem: function (storageKey) {
      queue = queue
        .catch(function () {})
        .then(async function () {
          // Removal follows pending writes in BOTH stores. Otherwise an older
          // queued write can recreate the tab capability after forgetting it.
          let sessionFailure = false;
          if (options.session) {
            try { options.session.removeItem(storageKey); }
            catch (e) { sessionFailure = true; }
          }
          if (database) await transaction(database, 'delete');
          if (sessionFailure) throw new Error('draft_storage_unavailable');
          value = null;
          key = null;
          remembered = null;
        });
      return queue;
    },
  };
}
module.exports = { createDraftStorage: createDraftStorage, DATABASE: DATABASE, STORE: STORE };
