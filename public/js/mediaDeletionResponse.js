(function initializeMediaDeletionResponse(global) {
  'use strict';

  function classify(response, data, fallbackMessage) {
    const success = response?.ok === true;
    const serverMessage =
      typeof data?.message === 'string' && data.message.trim()
        ? data.message.trim()
        : null;
    return Object.freeze({
      success,
      cleanupPending:
        success &&
        response.status === 202 &&
        data?.cleanupPending === true,
      message: serverMessage || fallbackMessage,
    });
  }

  global.CampPicsMediaDeletionResponse = Object.freeze({
    classify,
  });
})(window);
