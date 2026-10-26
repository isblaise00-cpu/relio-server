'use strict';

/** Erreur renvoyée au client de l'API sous la forme { error: { code, message } }. */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = { ApiError };
