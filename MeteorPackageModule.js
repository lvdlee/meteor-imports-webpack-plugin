const NormalModule = require("webpack/lib/NormalModule");

class MeteorPackageModule extends NormalModule {
  shouldPreventParsing() {
    return true;
  }

  /**
   * @param {Hash} hash the hash used to track dependencies
   * @param {UpdateHashContext} context context
   * @returns {void}
   */
  updateHash(hash, context) {
    hash.update("meteor");
    this.generator.updateHash(hash, {
      module: this,
      ...context,
    });
  }
}

module.exports = MeteorPackageModule;
