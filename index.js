const webpack = require("webpack");
let MeteorImportsPlugin = null;

if (webpack.version && webpack.version[0] > 4) {
  // webpack5 and upper
  MeteorImportsPlugin = require("./webpack5");
} else {
  // webpack4 and lower
  MeteorImportsPlugin = require("./webpack4");
}

module.exports = MeteorImportsPlugin;
