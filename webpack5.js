const fs = require("fs");
const _ = require("lodash");
const md5 = require("md5");
const path = require("path");
const AliasPlugin = require("enhanced-resolve/lib/AliasPlugin");
const { log, logWarn, logError } = require("./utils");
const MeteorPackageModule = require("./MeteorPackageModule");
const MeteorPackageBridgeModule = require("./MeteorPackageBridgeModule");
const BasicEffectRulePlugin = require("webpack/lib/rules/BasicEffectRulePlugin");
const BasicMatcherRulePlugin = require("webpack/lib/rules/BasicMatcherRulePlugin");
const RuleSetCompiler = require("webpack/lib/rules/RuleSetCompiler");
const UseEffectRulePlugin = require("webpack/lib/rules/UseEffectRulePlugin");

const objectMatcherRulePlugins = [];
try {
  const ObjectMatcherRulePlugin = require("webpack/lib/rules/ObjectMatcherRulePlugin");
  objectMatcherRulePlugins.push(
    new ObjectMatcherRulePlugin("assert", "assertions"),
    new ObjectMatcherRulePlugin("descriptionData")
  );
} catch (e) {
  const DescriptionDataMatcherRulePlugin = require("webpack/lib/rules/DescriptionDataMatcherRulePlugin");
  objectMatcherRulePlugins.push(new DescriptionDataMatcherRulePlugin());
}

const ruleSetCompiler = new RuleSetCompiler([
  new BasicMatcherRulePlugin("test", "resource"),
  new BasicMatcherRulePlugin("mimetype"),
  new BasicMatcherRulePlugin("dependency"),
  new BasicMatcherRulePlugin("include", "resource"),
  new BasicMatcherRulePlugin("exclude", "resource", true),
  new BasicMatcherRulePlugin("conditions"),
  new BasicMatcherRulePlugin("resource"),
  new BasicMatcherRulePlugin("resourceQuery"),
  new BasicMatcherRulePlugin("resourceFragment"),
  new BasicMatcherRulePlugin("realResource"),
  new BasicMatcherRulePlugin("issuer"),
  new BasicMatcherRulePlugin("compiler"),
  ...objectMatcherRulePlugins,
  new BasicEffectRulePlugin("type"),
  new BasicEffectRulePlugin("sideEffects"),
  new BasicEffectRulePlugin("parser"),
  new BasicEffectRulePlugin("resolve"),
  new BasicEffectRulePlugin("generator"),
  new UseEffectRulePlugin(),
]);

function escapeForRegEx(str) {
  return str.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

// Join an array with environment agnostic path identifiers
function arrToPathForRegEx(arr) {
  return arr
    .map(function (x) {
      return escapeForRegEx(x);
    })
    .join("/");
}

const BUILD_PATH_PARTS = [
  ".meteor",
  "local",
  "build",
  "programs",
  "web.browser",
];

// Note that these can vary between meteorProgramFolders and meteorFolder builds
const PACKAGES_PATH_PARTS = ["programs", "web.browser", "packages"];
const PACKAGES_REGEX_NOT_MODULES = new RegExp(
  arrToPathForRegEx(PACKAGES_PATH_PARTS) + "\\/(?!modules\\.js)[^/\\\\]+$"
);
const PACKAGES_REGEX_MODULES = new RegExp(
  arrToPathForRegEx(PACKAGES_PATH_PARTS) + "\\/modules\\.js$"
);
const PACKAGES_REGEX_GLOBAL_IMPORTS = /\/global-imports\.js$/;

const PLUGIN_NAME = "MeteorImportsWebpackPlugin";

class MeteorImportsPlugin {
  // Properties:
  //  options;
  //  config;
  //  mode

  constructor(options) {
    this.options = options;
  }

  apply(compiler) {
    this.initConfig(compiler);
    this.setPaths(compiler);
    this.addLoaders(compiler);

    compiler.hooks.compile.tap(PLUGIN_NAME, (params) => {
      const nmf = params.normalModuleFactory;

      // Add bridge modules from webpack's module system to meteor's for all dependencies starting with "meteor/"
      params.normalModuleFactory = this.setupPackageBridgeModules(nmf);

      // We don't want webpack's parsing of meteor packages (except modules) since they're using Meteor's package system
      nmf.hooks.createModule.tap(PLUGIN_NAME, (result) => {
        // TODO: Investigate if we can split this to e.g. startWith(meteorBuild) and match packages
        if (result.userRequest.match(PACKAGES_REGEX_NOT_MODULES)) {
          return new MeteorPackageModule(result);
        }
      });
    });

    // Add alias for meteor-imports
    compiler.hooks.afterResolvers.tap(PLUGIN_NAME, (compiler) => {
      compiler.resolverFactory.hooks.resolver
        .for("normal")
        .tap(PLUGIN_NAME, (resolver) => {
          this.addAlias(resolver);
        });
    });

    // Set up mechanism for injecting and emitting autoupdate information
    this.setupAutoupdateEmit(compiler);
  }

  initConfig(compiler) {
    const isProduction = this.mode === "production";

    const defaults = {
      emitAutoupdateVersion: true,
      exclude: {
        autoupdate: true,
      },
      excludeGlobals: [],
      injectMeteorRuntimeConfig: true,
      logIncludedPackages: false,
      logPackagesWithoutFiles: false,
      meteorFolder: undefined,
      meteorProgramsFolder: undefined,
      settingsFilePath: undefined,
      stripPackagesWithoutFiles: true,
      ddpDefaultConnectionPort: 3000,

      // These actually go directly to page
      DDP_DEFAULT_CONNECTION_URL: undefined,
      meteorEnv: {
        NODE_ENV: isProduction ? "production" : undefined,
      },
      PUBLIC_SETTINGS: undefined,
      ROOT_URL: undefined,
    };

    let exclude = this.options.exclude || {};
    if (Array.isArray(exclude))
      exclude = _.zipObject(
        exclude,
        exclude.map(() => true)
      );
    exclude = Object.assign({}, defaults.exclude, exclude);
    this.config = Object.assign(defaults, this.options, { exclude });

    this.mode = compiler.options.mode || "development";

    // Validate config
    if (this.options.settingsFilePath && this.options.PUBLIC_SETTINGS)
      logWarn(
        'Both "settingsFilePath" or "PUBLIC_SETTINGS" specified. "settingsFilePath" will be ignored.'
      );

    const isDevServer = !!process.argv.find((v) =>
      v.includes("webpack-dev-server")
    );
    if (exclude.autoupdate === false && isDevServer) {
      logWarn(
        "You have specified using autoupdate: false while running webpack-dev-server. " +
          "This typically leads to an ever reloading page if you don't start/stop meteor all " +
          "the time and provide environment variable AUTOUPDATE_VERSION. " +
          "Are you sure this is what you want to do?"
      );
    }

    if (this.config.DDP_DEFAULT_CONNECTION_PORT) {
      logWarn(
        '"DDP_DEFAULT_CONNECTION_PORT" is depcreated and now called "ddpDefaultConnectionPort'
      );
      this.config.ddpDefaultConnectionPort =
        this.config.DDP_DEFAULT_CONNECTION_PORT;
    }

    if (
      this.config.ddpDefaultConnectionPort &&
      this.config.DDP_DEFAULT_CONNECTION_URL
    ) {
      logWarn(
        'Both "DDP_DEFAULT_CONNETION_URL" and "ddpDefaultConnectionPort" specified. "ddpDefaultConnectionPort" will be ignored.'
      );
    }
  }

  setPaths(compiler) {
    const context = compiler.context;

    this.meteorBuild = this.config.meteorProgramsFolder
      ? path.resolve(context, this.config.meteorProgramsFolder, "web.browser")
      : path.resolve.apply(
          path,
          [context, this.config.meteorFolder].concat(BUILD_PATH_PARTS)
        );

    this.meteorPackages = path.join(this.meteorBuild, "packages");
  }

  addAlias(resolver) {
    // Provide the alias "meteor-imports"
    new AliasPlugin(
      "described-resolve",
      {
        name: "meteor-imports",
        onlyModule: true,
        alias: path.join(__dirname, "./meteor-imports.js"),
      },
      "resolve"
    ).apply(resolver);

    // Provide the alias "meteor-imports"
    new AliasPlugin(
      "described-resolve",
      {
        name: "meteor-config",
        onlyModule: true,
        alias: path.join(__dirname, "./meteor-config.js"),
      },
      "resolve"
    ).apply(resolver);
  }

  addLoaders(compiler) {
    const extraRules = [
      {
        test: /meteor-imports\.js$/,
        loader: path.join(__dirname, "meteor-imports.js"),
        options: {
          mode: this.mode,
          config: this.config,
          meteorBuild: this.meteorBuild,
        },
      },
      {
        test: /meteor-config\.js$/,
        loader: path.join(__dirname, "meteor-config.js"),
        options: {
          config: this.config,
        },
      },
      {
        test: PACKAGES_REGEX_NOT_MODULES,
        use: [
          {
            loader: path.join(__dirname, "package-loader.js"),
            options: this.config,
          },
        ],
      },
      {
        test: PACKAGES_REGEX_MODULES,
        loader: path.join(__dirname, "modules-loader.js"),
      },
      {
        test: PACKAGES_REGEX_GLOBAL_IMPORTS,
        loader: path.join(__dirname, "global-imports-loader.js"),
        options: this.config,
      },
      {
        test: /\.css$/,
        include: [this.meteorPackages],
        use: [{ loader: "style-loader" }, { loader: "css-loader" }],
      },
    ];

    compiler.options.module.rules =
      compiler.options.module.rules.concat(extraRules);
  }

  setupPackageBridgeModules(nmf) {
    // We must (?) hook directly on normalModuleFactory.hooks.resolver in order to return a direct module,
    // which in turn is one of few ways to direct a request to a code string without access the file system
    nmf.hooks.resolve.tapAsync(PLUGIN_NAME, (data, callback) => {
      const request = data.request;

      if (request.startsWith("meteor/")) {
        // console.log(nmf);
        return callback(null, new MeteorPackageBridgeModule(request, nmf));
      }

      callback();
    });
    return nmf;
  }

  setupAutoupdateEmit(compiler) {
    if (
      this.config.exclude["autoupdate"] === true ||
      !this.config.emitAutoupdateVersion
    )
      return;

    compiler.hooks.afterPlugins.tap(PLUGIN_NAME, (compiler) => {
      compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
        let afterHtmlHook =
          compilation.hooks.htmlWebpackPluginAfterHtmlProcessing;
        if (!afterHtmlHook) {
          logError(
            "The emitAutoupdateVersion setting requires HtmlWebpackPlugin being added and it wasn't found."
          );
          return;
        }
        afterHtmlHook.tap(PLUGIN_NAME, (data) => {
          const hash = md5(data.html);
          data.html = data.html.replace(
            /(<\s*head\s*>)/,
            `$1\n<script>window.__meteor_runtime_config__ = {autoupdateVersion:"${hash}"}</script>`
          );

          // Also kick off an async write to the output file
          let outputPath = compiler.options.output.path;
          const outputFile = path.join(outputPath, "autoupdate_version");
          fs.mkdir(path.dirname(outputFile), () => {
            fs.writeFile(outputFile, hash, (err) => {
              if (err) logError("Unable to write autoupdate_version file", err);
              else log("Wrote autoupdate_version file to ", outputFile);
            });
          });
        });
      });
    });
  }
}

module.exports = MeteorImportsPlugin;
