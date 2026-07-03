'use strict';

const { MhiPlatform, PLATFORM_NAME } = require('./platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, MhiPlatform);
};
