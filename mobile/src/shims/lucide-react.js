// Metro serves this for `lucide-react` when the importer lives in ../src
// (see metro.config.js). babel-plugin-lucide.js rewrites each named icon
// import to its lucide-react-native file wrapped in wrapIcon, so the
// desktop's `className="icon-sm text-danger"` becomes size/colour props
// and animate-spin/pulse still animate. Only wrapIcon is exported: a
// lookup of every icon by name is what pulled all of lucide into the
// bundle.
const React = require('react')
const { tw } = require('../tw')
const { Spin, Pulse } = require('../components/Spin')
const { c } = require('../theme')

function wrap(name, Icon) {
  function NessIcon({ className, size, color, fill, style, strokeWidth }) {
    const t = tw(className)
    const fillCurrent = typeof className === 'string' && className.includes('fill-current')
    const col = color ?? t.color ?? c.muted
    let el = React.createElement(Icon, {
      size: size ?? t.size ?? 16,
      color: col,
      fill: fill ?? (fillCurrent ? col : 'none'),
      strokeWidth,
      style: t.opacity != null ? [{ opacity: t.opacity }, style] : style
    })
    if (t.spin) el = React.createElement(Spin, null, el)
    if (t.pulse) el = React.createElement(Pulse, null, el)
    return el
  }
  NessIcon.displayName = name
  return NessIcon
}

module.exports = { wrapIcon: wrap }
