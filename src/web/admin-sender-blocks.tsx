/**
 * Blocked senders page of the system administration.
 *
 * The app never sets a permanent block itself: "Uebernommen" only records that the operator set it outside
 * of Canvaz.
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, RotateCcw, Unlock, X } from 'lucide-react'

import type { MeResponse, SenderBlockKindView, SenderBlockProposalView, SenderBlockView } from '../contracts/api.js'
import { ApiError, decideSenderBlockProposal, fetchSenderBlocks, liftSenderBlock } from './api.js'
import { Dialog } from './overlays.js'
import { Badge, Button, Notice, PageState, TableSkeleton } from './ui.js'

const BLOCK_COLUMNS = ['Adresse', 'Art', 'Grund', 'Fehlschlaege', 'Gesperrt seit', 'Laeuft ab', 'Aktion']
const PROPOSAL_COLUMNS = ['Adresse', 'Art', 'Erste Sperre', 'Zweite Sperre', 'Aktion']

const KIND_LABELS: Record<SenderBlockKindView, string> = {
  ipv4: 'IPv4-Adresse',
  'ipv6-64': 'IPv6-Praefix (/64)',
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE')
}

export function AdminSenderBlocks({ me }: { readonly me: MeResponse }) {
  const [data, setData] = useState<{ blocks: readonly SenderBlockView[]; proposals: readonly SenderBlockProposalView[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [liftFor, setLiftFor] = useState<SenderBlockView | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetchSenderBlocks()
      .then(setData)
      .catch((cause: unknown) => {
        setData((previous) => previous ?? { blocks: [], proposals: [] })
        setError(cause instanceof ApiError ? cause.message : 'Die gesperrten Absender konnten nicht geladen werden.')
      })
  }, [])

  useEffect(load, [load])

  function run(key: string, action: Promise<unknown>, fallback: string): void {
    setPendingKey(key)
    setError(null)
    action
      .then(load)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : fallback)
      })
      .finally(() => {
        setPendingKey(null)
      })
  }

  return (
    <section aria-labelledby="sender-blocks-heading">
      <h2 id="sender-blocks-heading">Gesperrte Absender</h2>
      <p className="hint">
        Absender, die nach zu vielen fehlgeschlagenen Anmeldungen voruebergehend gesperrt wurden. Die Daten dienen
        ausschliesslich der Sicherheit der Anmeldewege.
      </p>
      {error !== null && (
        <Notice>
          <p>{error}</p>
          <p className="actions">
            <Button icon={RotateCcw} onClick={load}>
              Erneut laden
            </Button>
          </p>
        </Notice>
      )}

      <h3>Aktive Sperren</h3>
      {data === null && <TableSkeleton columns={BLOCK_COLUMNS} label="Sperren werden geladen …" />}
      {data !== null && data.blocks.length === 0 && error === null && (
        <PageState kind="empty" title="Keine aktiven Sperren" description="Zurzeit ist kein Absender gesperrt." />
      )}
      {data !== null && data.blocks.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Aktive Absendersperren</caption>
            <thead>
              <tr>
                {BLOCK_COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.blocks.map((block) => (
                <tr key={block.address}>
                  <td data-label="Adresse">
                    <code className="whitespace-nowrap">{block.address}</code>
                  </td>
                  <td data-label="Art">{KIND_LABELS[block.kind]}</td>
                  <td data-label="Grund">{block.reason}</td>
                  <td data-label="Fehlschlaege">{block.failureCount}</td>
                  <td data-label="Gesperrt seit">{formatTime(block.blockedAt)}</td>
                  <td data-label="Laeuft ab">{formatTime(block.expiresAt)}</td>
                  <td data-label="Aktion">
                    <Button
                      icon={Unlock}
                      busy={pendingKey === block.address}
                      onClick={() => {
                        setLiftFor(block)
                      }}
                      aria-label={`Sperre fuer ${block.address} aufheben`}
                    >
                      Aufheben
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Offene Vorschlaege fuer dauerhafte Sperren</h3>
      <p className="hint">
        Wurde dieselbe Adresse binnen 30 Tagen erneut gesperrt, schlaegt Canvaz eine dauerhafte Sperre vor. Sie
        wird nie von Canvaz gesetzt, sondern ausserhalb, etwa an der Firewall.
      </p>
      {data === null && <TableSkeleton columns={PROPOSAL_COLUMNS} label="Vorschlaege werden geladen …" />}
      {data !== null && data.proposals.length === 0 && error === null && (
        <PageState kind="empty" title="Keine offenen Vorschlaege" description="Zurzeit wartet kein Vorschlag auf eine Entscheidung." />
      )}
      {data !== null && data.proposals.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Offene Vorschlaege fuer dauerhafte Sperren</caption>
            <thead>
              <tr>
                {PROPOSAL_COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.proposals.map((proposal) => {
                const busy = pendingKey === proposal.id
                return (
                  <tr key={proposal.id}>
                    <td data-label="Adresse">
                      <code className="whitespace-nowrap">{proposal.address}</code>
                    </td>
                    <td data-label="Art">
                      <Badge>{KIND_LABELS[proposal.kind]}</Badge>
                    </td>
                    <td data-label="Erste Sperre">{formatTime(proposal.firstBlockedAt)}</td>
                    <td data-label="Zweite Sperre">{formatTime(proposal.secondBlockedAt)}</td>
                    <td data-label="Aktion">
                      <span className="actions">
                        <Button
                          icon={Check}
                          busy={busy}
                          onClick={() => {
                            run(
                              proposal.id,
                              decideSenderBlockProposal(me.csrfToken, { id: proposal.id, status: 'accepted' }),
                              'Der Vorschlag konnte nicht als uebernommen markiert werden.',
                            )
                          }}
                          title="Die dauerhafte Sperre wurde ausserhalb von Canvaz gesetzt."
                          aria-label={`Vorschlag fuer ${proposal.address} als uebernommen markieren`}
                        >
                          Uebernommen
                        </Button>
                        <Button
                          variant="quiet"
                          icon={X}
                          busy={busy}
                          onClick={() => {
                            run(
                              proposal.id,
                              decideSenderBlockProposal(me.csrfToken, { id: proposal.id, status: 'rejected' }),
                              'Der Vorschlag konnte nicht verworfen werden.',
                            )
                          }}
                          aria-label={`Vorschlag fuer ${proposal.address} verwerfen`}
                        >
                          Verworfen
                        </Button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={liftFor !== null}
        title="Sperre aufheben"
        onClose={() => {
          setLiftFor(null)
        }}
      >
        <p>
          Die Sperre fuer <code>{liftFor?.address}</code> endet sofort. Die Zaehlung der Fehlschlaege beginnt neu,
          die Vorgeschichte der Sperre bleibt fuer einen Vorschlag dauerhafter Sperren erhalten.
        </p>
        <p className="actions">
          <Button
            icon={Unlock}
            onClick={() => {
              const block = liftFor
              setLiftFor(null)
              if (block !== null) {
                run(
                  block.address,
                  liftSenderBlock(me.csrfToken, { address: block.address }),
                  'Die Sperre konnte nicht aufgehoben werden.',
                )
              }
            }}
          >
            Sperre aufheben
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setLiftFor(null)
            }}
          >
            Abbrechen
          </Button>
        </p>
      </Dialog>
    </section>
  )
}
