const { existsSync } = require('fs');
const { resolve, sep, dirname, extname } = require('path');
const webpackMerge = require('webpack-merge');
const { extensions, jsVariants } = require('interpret');
const GroupHelper = require('../utils/GroupHelper');
const rechoir = require('rechoir');
const ConfigError = require('../utils/errors/ConfigError');
const logger = require('../utils/logger');

// Order defines the priority, in increasing order
// example - config file lookup will be in order of .webpack/webpack.config.development.js -> webpack.config.development.js -> webpack.config.js
const DEFAULT_CONFIG_LOC = [
    'webpack.config',
    'webpack.config.dev',
    'webpack.config.development',
    'webpack.config.prod',
    'webpack.config.production',
    '.webpack/webpack.config',
    '.webpack/webpack.config.none',
    '.webpack/webpack.config.dev',
    '.webpack/webpack.config.development',
    '.webpack/webpack.config.prod',
    '.webpack/webpack.config.production',
    '.webpack/webpackfile',
];

const modeAlias = {
    production: 'prod',
    development: 'dev',
};

const getDefaultConfigFiles = () => {
    return DEFAULT_CONFIG_LOC.map((filename) => {
        // Since .cjs is not available on interpret side add it manually to default config extension list
        return [...Object.keys(extensions), '.cjs'].map((ext) => {
            return {
                path: resolve(filename + ext),
                ext: ext,
                module: extensions[ext],
            };
        });
    }).reduce((a, i) => a.concat(i), []);
};

const getConfigInfoFromFileName = (filename) => {
    const ext = extname(filename);
    // since we support only one config for now
    const allFiles = [filename];
    // return all the file metadata
    return allFiles
        .map((file) => {
            return {
                path: resolve(file),
                ext: ext,
                module: extensions[ext] || null,
            };
        })
        .filter((e) => existsSync(e.path));
};

class ConfigGroup extends GroupHelper {
    constructor(options) {
        super(options);
    }

    requireLoader(extension, path) {
        rechoir.prepare(extensions, path, process.cwd());
    }

    requireConfig(configModule) {
        const extension = Object.keys(jsVariants).find((t) => configModule.ext.endsWith(t));

        if (extension) {
            this.requireLoader(extension, configModule.path);
        }

        let config = require(configModule.path);
        if (config.default) {
            config = config.default;
        }

        return {
            content: config,
            path: configModule.path,
        };
    }

    async finalize(moduleObj) {
        const { argv } = this.args;
        const newOptionsObject = {
            outputOptions: {},
            options: {},
        };

        if (!moduleObj) {
            return newOptionsObject;
        }
        const configPath = moduleObj.path;
        const configOptions = moduleObj.content;
        if (typeof configOptions === 'function') {
            // when config is a function, pass the env from args to the config function
            let formattedEnv;
            if (Array.isArray(this.args.env)) {
                formattedEnv = this.args.env.reduce((envObject, envOption) => {
                    envObject[envOption] = true;
                    return envObject;
                }, {});
            }
            const newOptions = configOptions(formattedEnv, argv);
            // When config function returns a promise, resolve it, if not it's resolved by default
            newOptionsObject['options'] = await Promise.resolve(newOptions);
        } else if (Array.isArray(configOptions) && this.args.configName) {
            // In case of exporting multiple configurations, If you pass a name to --config-name flag,
            // webpack will only build that specific configuration.
            const namedOptions = configOptions.filter((opt) => this.args.configName.includes(opt.name));
            if (namedOptions.length === 0) {
                logger.error(`Configuration with name "${this.args.configName}" was not found.`);
                process.exit(2);
            } else {
                newOptionsObject['options'] = namedOptions;
            }
        } else {
            if (Array.isArray(configOptions) && !configOptions.length) {
                newOptionsObject['options'] = {};
                return newOptionsObject;
            }
            newOptionsObject['options'] = configOptions;
        }

        //warn the user if bail and watch both are used together
        const { bail, watch } = newOptionsObject['options'];
        if (bail && watch) {
            logger.warn('You are using "bail" with "watch". "bail" will still exit webpack when the first error is found.');
        }

        if (configOptions && configPath.includes('.webpack')) {
            const currentPath = configPath;
            const parentContext = dirname(currentPath).split(sep).slice(0, -1).join(sep);
            if (Array.isArray(configOptions)) {
                configOptions.forEach((config) => {
                    config.context = config.context || parentContext;
                });
            } else {
                configOptions.context = configOptions.context || parentContext;
            }
            newOptionsObject['options'] = configOptions;
        }
        return newOptionsObject;
    }

    async resolveConfigFiles() {
        const { config, mode } = this.args;
        if (config.length > 0) {
            const resolvedOptions = [];
            const finalizedConfigs = config.map(async (webpackConfig) => {
                const configPath = resolve(webpackConfig);
                const configFiles = getConfigInfoFromFileName(configPath);
                if (!configFiles.length) {
                    throw new ConfigError(`The specified config file doesn't exist in ${configPath}`);
                }
                const foundConfig = configFiles[0];
                const resolvedConfig = this.requireConfig(foundConfig);
                return this.finalize(resolvedConfig);
            });
            // resolve all the configs
            for await (const resolvedOption of finalizedConfigs) {
                if (Array.isArray(resolvedOption.options)) {
                    resolvedOptions.push(...resolvedOption.options);
                } else {
                    resolvedOptions.push(resolvedOption.options);
                }
            }
            // When the resolved configs are more than 1, then pass them as Array [{...}, {...}] else pass the first config object {...}
            const finalOptions = resolvedOptions.length > 1 ? resolvedOptions : resolvedOptions[0] || {};

            this.opts['options'] = finalOptions;
            return;
        }

        // When no config is supplied, lookup for default configs
        const defaultConfigFiles = getDefaultConfigFiles();
        const tmpConfigFiles = defaultConfigFiles.filter((file) => {
            return existsSync(file.path);
        });

        const configFiles = tmpConfigFiles.map(this.requireConfig.bind(this));
        if (configFiles.length) {
            const defaultConfig = configFiles.find((p) => p.path.includes(mode) || p.path.includes(modeAlias[mode]));
            if (defaultConfig) {
                this.opts = await this.finalize(defaultConfig);
                return;
            }
            const foundConfig = configFiles.pop();
            this.opts = await this.finalize(foundConfig);
            return;
        }
    }

    async resolveConfigMerging() {
        const { merge } = this.args;
        if (merge) {
            // Get the current configuration options
            const { options: configOptions } = this.opts;

            // we can only merge when there are multiple configurations
            // either by passing multiple configs by flags or passing a
            // single config exporting an array
            if (!Array.isArray(configOptions)) {
                throw new ConfigError('Atleast two configurations are required for merge.', 'MergeError');
            }

            // We return a single config object which is passed to the compiler
            const mergedOptions = configOptions.reduce((currentConfig, mergedConfig) => webpackMerge(currentConfig, mergedConfig), {});
            this.opts['options'] = mergedOptions;
        }
    }

    async run() {
        await this.resolveConfigFiles();
        await this.resolveConfigMerging();
        return this.opts;
    }
}

module.exports = ConfigGroup;
