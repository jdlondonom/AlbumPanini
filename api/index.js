"use strict";

const { createApp } = require("../lib/app");

function createHandler(applicationFactory = createApp) {
  let applicationPromise;
  return async function handler(request, response) {
    if (!applicationPromise) {
      applicationPromise = applicationFactory()
        .then(result => result.app)
        .catch(error => {
          applicationPromise = null;
          throw error;
        });
    }
    const app = await applicationPromise;
    return new Promise((resolve, reject) => {
      response.once("finish", resolve);
      response.once("close", resolve);
      try {
        app(request, response);
      } catch (error) {
        reject(error);
      }
    });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
