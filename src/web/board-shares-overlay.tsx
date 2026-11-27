/**
 * Share management of a board as its own wide dialog.
 *
 * The share and guest link tables scroll far horizontally in the narrow info panel; the dialog, modelled
 * on the version history (`board-versions.tsx`), gives them room. It depends only on props, not on editor
 * state, so it can open for any board, even without an open editor. Focus trap, Escape and focus return
 * come from `showModal()`.
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
