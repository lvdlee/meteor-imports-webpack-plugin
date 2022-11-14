const NormalModule = require("webpack/lib/NormalModule");

module.exports = class MeteorPackageBridgeModule extends NormalModule {
  constructor(request, nmf) {
    const type = "javascript/dynamic";
    const parser = nmf.getParser(type);
    const generator = nmf.getGenerator(type);

    super({
      type: type,
      request,
      resource: request,
      userRequest: request,
      parser,
      generator,
      loaders: [],
    });
  }

  build(options, compilation, resolver, fs, callback) {
    super.build(
      options,
      compilation,
      resolver,
      /* fileSystem (only readFile required): */ this,
      callback
    );
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

  readFile(path, cb) {
    return cb(null, `module.exports = require("meteor-imports")("${path}");`);
  }
};
