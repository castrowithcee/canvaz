/**
 * Freigabeverwaltung eines Boards als eigener breiter Dialog.
 *
 * Die Tabellen von Freigaben und Gastlinks scrollen in der schmalen Informationsleiste weit horizontal; der
 * Dialog nach dem Muster des Versionsverlaufs (`board-versions.tsx`) gibt ihnen Platz. Er haengt nur an
 * Props und nicht am Editorzustand und laesst sich damit fuer jedes Board oeffnen, auch ohne geoeffneten
 * Editor. Fokusfang, Escape und Fokusrueckgabe kommen von `showModal()`.
 */

import type { MeResponse } from '../contracts/api.js'
import { BoardShare } from './board-share.js'
import { Dialog } from './overlays.js'

export function BoardSharesOverlay({
  me,
  boardId,
  boardTitle,
  open,
  onChanged,
  onClose,
}: {
  readonly me: MeResponse
  readonly boardId: string
  readonly boardTitle: string
  readonly open: boolean
  readonly onChanged: () => void
  readonly onClose: () => void
}) {
  return (
    <Dialog open={open} title={`Freigaben von ${boardTitle}`} wide onClose={onClose}>
      {/* Only mounted while open: a fresh load per opening, and a plaintext guest link never outlives it. */}
      {open && <BoardShare me={me} boardId={boardId} onChanged={onChanged} />}
    </Dialog>
  )
}
