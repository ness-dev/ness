// babel.config.js (not .babelrc) so it also covers the desktop modules
// Metro pulls in from ../src. babel-preset-expo is nested under expo/.
module.exports = function (api) {
  api.cache(true)
  return {
    presets: [require.resolve('babel-preset-expo', { paths: [require.resolve('expo/package.json')] })],
    plugins: ['./babel-plugin-lucide.js']
  }
}
