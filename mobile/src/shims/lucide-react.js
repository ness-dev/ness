// Metro serves this for `lucide-react` when the importer lives in ../src
// (see metro.config.js). lucide-react-native exports the same icon names;
// each is wrapped so the desktop's `className="icon-sm text-danger"`
// becomes size/colour props, and animate-spin/pulse still animate.
const React = require('react')
const L = require('lucide-react-native')
const { tw } = require('../tw')
const { Spin, Pulse } = require('../components/Spin')
const { c } = require('../theme')

const cache = Object.create(null)

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

module.exports = new Proxy(
  {},
  {
    get(_t, name) {
      if (name === '__esModule') return true
      if (typeof name !== 'string') return undefined
      if (name in cache) return cache[name]
      const Icon = L[name]
      cache[name] = Icon ? wrap(name, Icon) : undefined
      return cache[name]
    }
  }
)
