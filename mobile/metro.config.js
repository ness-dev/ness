// The app imports Ness's reducers and WS transport straight from
// ../src/shared (no copy, no package). That folder sits outside the
// project root and the repo is not an npm workspace, so Expo's
// monorepo auto-config doesn't kick in — watch it explicitly.
//
// src/shared has no bare-specifier imports, so it never needs the
// parent repo's node_modules. nodeModulesPaths keeps any future bare
// import from shared resolving against mobile/node_modules first.
// Don't set disableHierarchicalLookup: npm nests some Expo deps
// (expo/node_modules/expo-asset) and the native bundle can't find them.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '../src/shared')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [...(config.watchFolders ?? []), sharedRoot]
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')]

module.exports = config
