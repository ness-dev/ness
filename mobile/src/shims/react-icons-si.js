// Stand-in for `react-icons/si` (web-only brand SVGs) when imported from
// ../src. Every brand icon becomes lucide's Plug in the brand colour the
// desktop passes — recognisable enough in a tool chip until real RN brand
// marks are worth bundling.
const React = require('react')
const { Plug } = require('lucide-react-native')
const { tw } = require('../tw')

function Brand({ className, color }) {
  const t = tw(className)
  return React.createElement(Plug, { size: t.size ?? 16, color: color ?? t.color ?? '#a3a3a3' })
}

module.exports = new Proxy(
  {},
  {
    get(_t, name) {
      if (name === '__esModule') return true
      return typeof name === 'string' ? Brand : undefined
    }
  }
)
