const webpack = require("webpack");
let MeteorImportsPlugin = null;

if (webpack.version && webpack.version[0] > 4) {
  // webpack5 and upper
  MeteorImportsPlugin = require("./webpack5");
} else {
  // webpack4 and lower
  if (webpack.version && webpack.version[0] > 3) {
    MeteorImportsPlugin = require("./webpack4");
  } else {
    MeteorImportsPlugin = require("./webpack3");
  }
}

module.exports = MeteorImportsPlugin;
