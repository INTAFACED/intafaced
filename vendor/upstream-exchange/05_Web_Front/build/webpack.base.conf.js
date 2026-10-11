'use strict'
const path = require('path')
const utils = require('./utils')
const config = require('../config')
const vueLoaderConfig = require('./vue-loader.conf')
const { VueLoaderPlugin } = require('vue-loader')

function resolve(dir) {
    return path.join(__dirname, '..', dir)
}

module.exports = {
    context: path.resolve(__dirname, '../'),
    entry: {
        app: ['./node_modules/babel-polyfill/dist/polyfill.js', './src/main.js']
    },
    output: {
        path: config.build.assetsRoot,
        filename: '[name].js',
        publicPath: process.env.NODE_ENV === 'production' ?
            config.build.assetsPublicPath : config.dev.assetsPublicPath
    },
    module: {
        rules: [
            // ...(config.dev.useEslint ? [createLintingRule()] : []),
            {
                test: /\.vue$/,
                loader: 'vue-loader',
                options: vueLoaderConfig
            },
            {
                test: /\.(png|jpe?g|gif|svg|webp)(\?.*)?$/,
                type: 'asset',
                parser: { dataUrlCondition: { maxSize: 10000 } },
                generator: {
                    filename: utils.assetsPath('img/[name].[contenthash:7][ext]')
                }
            },
            {
                test: /\.(mp4|webm|ogg|mp3|wav|flac|aac)(\?.*)?$/,
                type: 'asset',
                parser: { dataUrlCondition: { maxSize: 10000 } },
                generator: { filename: utils.assetsPath('media/[name].[contenthash:7][ext]') }
            },
            {
                test: /\.(woff2?|eot|ttf|otf)(\?.*)?$/,
                type: 'asset',
                parser: { dataUrlCondition: { maxSize: 10000 } },
                generator: { filename: utils.assetsPath('fonts/[name].[contenthash:7][ext]'), publicPath: '/' }
            }
        ]
    },
    resolve: {
        extensions: ['.js', '.vue', '.json', '.less'],
        alias: {
            'vue$': 'vue/dist/vue.esm.js',
            '@': resolve('src'),
            '@js': resolve('src/assets/js'),
            '@components': resolve('src/components')
        },
        fallback: {
            dgram: false,
            fs: false,
            net: false,
            tls: false,
            child_process: false
        }
    },
    plugins: [new VueLoaderPlugin()]
}
