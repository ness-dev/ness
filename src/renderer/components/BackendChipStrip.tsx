import { useCallback, useState } from 'react'
import { Laptop, Layers, Server, Plus, X, ArrowUp, Loader2 } from 'lucide-react'
import { useBackend } from '../backend'
import {
  useConnections,
  useActiveBackend,
  useBackendStatus,
  useRemoteServerVersion,
  useSshBootstrapForConnection,
  getBackendsRegistry,
  reconnectBackend
} from '../store'
import { isInFlightPhase } from '../../shared/state/ssh-bootstrap'
import { setFleetViewMode, useFleetViewMode } from '../fleet-view'
import { Tooltip } from './Tooltip'
import type { BackendConnection } from '../types'

interface BackendChipStripProps {
  /** Opens the add-backend modal. Wired up alongside the modal in a
   *  later commit; the + button is rendered now so the strip's spec
   *  matches the design doc. */
  onAddBackend: () => void
}

/** Horizontal strip of avatar+label chips for each configured backend.
 *  Rendered above the bottom icon row in the Sidebar; hidden when
 *  there's only one backend (the auto-seeded Local), per design §A.
 *
 *  Click a chip to switch the active backend — registry.setActive()
 *  flips which store the slice hooks read from, the preload's router
 *  redirects backend RPCs, and we persist activeBackendId via
 *  backend.connectionsSetActive() so the choice survives a restart.
 */
export function BackendChipStrip({ onAddBackend }: BackendChipStripProps): JSX.Element | null {
  const connections = useConnections()
  const active = useActiveBackend()
  const backend = useBackend()
  const viewMode = useFleetViewMode()

  const handleSelect = useCallback((id: string) => {
    // Clicking a host chip always lands in single view of that host —
    // including a click on the already-active host while in merged view,
    // which is why the early-return is gated on the mode too.
    setFleetViewMode('single')
    if (id === active.id) return
    getBackendsRegistry().setActive(id)
    void backend.connectionsSetActive(id)
    void backend.connectionsSetLastConnected(id)
  }, [active.id, backend])

  const handleRemove = useCallback(
    (conn: BackendConnection) => {
      const ok = window.confirm(
        `Remove backend "${conn.label}"?\n\nThe connection settings and saved auth token will be deleted from this Ness install. The remote server itself is not affected — you can re-add it later.`
      )
      if (!ok) return
      // Close the WS transport + drop from the registry first; the chip
      // disappears immediately and the user lands back on Local. Then
      // persist via main so the entry is gone on next launch.
      getBackendsRegistry().remove(conn.id)
      void backend.connectionsRemove(conn.id)
    },
    [backend]
  )

  // Auto-hide when only Local exists (per design §A) — single-backend
  // installs see no chrome change. `File → Add Backend…` in the
  // Electron menu is the entry point for the first remote; once the
  // user adds one, the strip reveals with both chips + the `+` button.
  if (connections.length <= 1) return null

  return (
    <div className="border-t border-border px-2 py-1.5 shrink-0 flex items-center gap-1.5 overflow-x-auto">
      <Tooltip label="All hosts — one combined list" side="top">
        <button
          onClick={() => setFleetViewMode('merged')}
          className={`shrink-0 h-9 px-2.5 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer border ${
            viewMode === 'merged'
              ? 'bg-surface text-fg-bright border-border-strong'
              : 'text-dim hover:text-fg hover:bg-surface border-transparent'
          }`}
          aria-label="Show all hosts"
          aria-pressed={viewMode === 'merged'}
        >
          <Layers className="icon-sm" />
          <span className="text-xs font-medium">All</span>
        </button>
      </Tooltip>
      {connections.map((conn) => (
        <BackendChip
          key={conn.id}
          connection={conn}
          isActive={viewMode === 'single' && conn.id === active.id}
          onSelect={handleSelect}
          onRemove={handleRemove}
        />
      ))}
      <Tooltip label="Add backend" side="top">
        <button
          onClick={onAddBackend}
          className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-dim hover:text-fg hover:bg-surface transition-colors cursor-pointer border border-dashed border-border-strong"
          aria-label="Add backend"
        >
          <Plus className="icon-sm" />
        </button>
      </Tooltip>
    </div>
  )
}

interface BackendChipProps {
  connection: BackendConnection
  isActive: boolean
  onSelect: (id: string) => void
  onRemove: (connection: BackendConnection) => void
}

function BackendChip({ connection, isActive, onSelect, onRemove }: BackendChipProps): JSX.Element {
  const Icon = connection.kind === 'local' ? Laptop : Server
  const status = useBackendStatus(connection.id)
  const backend = useBackend()
  const serverVersion = useRemoteServerVersion(connection.id)
  const bootstrap = useSshBootstrapForConnection(connection.id)
  const [upgrading, setUpgrading] = useState(false)
  const isRemote = connection.kind === 'remote'
  const canUpgrade = Boolean(connection.ssh) && serverVersion?.upgradeAvailable === true

  // Two independent signals feed the chip: the WS transport's own
  // connected/disconnected flag, and (for SSH backends) the tunnel
  // bootstrap phase from main. The tunnel is the layer underneath, so
  // while it's rebuilding we show "reconnecting" even though the socket
  // above it is, strictly speaking, just down.
  const reconnecting = !!bootstrap && isInFlightPhase(bootstrap.phase)
  const tunnelDown =
    !!bootstrap && (bootstrap.phase === 'disconnected' || bootstrap.phase === 'error')
  const disconnected = !reconnecting && (status.state === 'disconnected' || tunnelDown)

  const lastLine = bootstrap?.lines[bootstrap.lines.length - 1]
  const tooltip = reconnecting
    ? `${connection.label} — reconnecting…${lastLine ? '\n' + lastLine : ''}`
    : disconnected
      ? `${connection.label} — disconnected${
          bootstrap?.error?.message
            ? ': ' + bootstrap.error.message
            : status.reason
              ? ': ' + status.reason
              : ''
        }${lastLine && !bootstrap?.error ? '\n' + lastLine : ''}`
      : serverVersion
        ? `${connection.label} — harness-server ${serverVersion.installed}`
        : connection.label

  const handleUpgrade = useCallback(async () => {
    if (!serverVersion || upgrading) return
    const ok = window.confirm(
      `Upgrade harness-server on "${connection.label}" from ${serverVersion.installed} to ${serverVersion.expected}?\n\n` +
        `The remote server will be restarted. Every terminal and agent session running on that machine will be terminated.`
    )
    if (!ok) return
    setUpgrading(true)
    try {
      await backend.sshUpgradeServer({
        bootstrapId: `upgrade-${connection.id}-${Date.now()}`,
        connectionId: connection.id
      })
      // The server came back on a new port with a new token, so the
      // existing socket is dead — swap in a transport pointed at the
      // fresh tunnel.
      await reconnectBackend(connection.id)
    } catch (err) {
      window.alert(
        `Upgrade failed for "${connection.label}":\n\n${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setUpgrading(false)
    }
  }, [backend, connection.id, connection.label, serverVersion, upgrading])

  // Outer wrapper is a div, not a button, so the inner remove `<button>`
  // doesn't nest button elements (invalid HTML). The chip body is a
  // button; the remove X is a separate button positioned over the
  // top-right corner and only revealed on hover for remote chips
  // (Local is pinned per design §H, no remove affordance).
  return (
    <div className="group relative shrink-0">
      <Tooltip label={tooltip} side="top">
        <button
          onClick={() => onSelect(connection.id)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors cursor-pointer min-w-0 ${
            disconnected
              ? 'bg-panel/40 border-border text-faint hover:text-dim'
              : reconnecting
                ? 'bg-panel/60 border-warning/50 text-dim hover:text-fg'
                : isActive
                  ? 'bg-surface text-fg-bright border-fg'
                  : 'bg-panel border-border text-dim hover:text-fg hover:border-border-strong'
          }`}
          style={{ maxWidth: 120, opacity: disconnected ? 0.55 : reconnecting ? 0.8 : 1 }}
        >
          <span
            className={`shrink-0 w-7 h-7 rounded flex items-center justify-center relative ${
              isActive ? 'bg-app/40' : 'bg-app/30'
            }`}
            style={connection.color ? { backgroundColor: connection.color } : undefined}
          >
            {connection.initials ? (
              <span className="text-xs font-semibold uppercase">
                {connection.initials.slice(0, 2)}
              </span>
            ) : (
              <Icon className="icon-sm" />
            )}
            {disconnected && (
              <span
                className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-danger ring-2 ring-panel"
                aria-hidden="true"
              />
            )}
            {reconnecting && !upgrading && (
              <Loader2
                className="icon-2xs absolute -bottom-1 -right-1 animate-spin text-warning"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="text-xs font-medium truncate min-w-0">{connection.label}</span>
        </button>
      </Tooltip>
      {(canUpgrade || upgrading) && (
        <Tooltip
          label={
            upgrading
              ? `Upgrading ${connection.label}…`
              : `harness-server ${serverVersion?.installed} — this Ness is ${serverVersion?.expected}. Click to upgrade (restarts the remote, ending its sessions).`
          }
          side="top"
        >
          <button
            type="button"
            disabled={upgrading}
            onClick={(e) => {
              e.stopPropagation()
              void handleUpgrade()
            }}
            aria-label={`Upgrade harness-server on ${connection.label}`}
            className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-panel-raised border border-accent text-accent flex items-center justify-center cursor-pointer disabled:cursor-default"
          >
            {upgrading ? (
              <Loader2 strokeWidth={2.5} className="icon-2xs animate-spin" />
            ) : (
              <ArrowUp strokeWidth={3} className="icon-2xs" />
            )}
          </button>
        </Tooltip>
      )}
      {isRemote && (
        <Tooltip label="Remove backend" side="top">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(connection)
            }}
            aria-label={`Remove ${connection.label}`}
            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-panel-raised border border-border-strong text-faint hover:text-danger hover:border-danger flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <X strokeWidth={2.5} className="icon-2xs" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
