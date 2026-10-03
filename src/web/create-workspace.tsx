import type { MeResponse, WorkspaceView } from '../contracts/api.js'
import { MAX_WORKSPACE_NAME_LENGTH } from '../domain/workspace/model.js'
import { ApiError, createWorkspace } from './api.js'
import { NameDialog } from './overlays.js'

/**
 * Der eine Anlegeweg fuer Arbeitsbereiche: Seitenleiste, Verwaltungsuebersicht und leere Startseite oeffnen
 * denselben Dialog. Schliessen und Weiterleiten nach Erfolg liegt bei der Huelle (`onCreated`).
 */
export function CreateWorkspaceDialog({
  me,
  open,
  onClose,
  onCreated,
}: {
  readonly me: MeResponse
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreated: (workspace: WorkspaceView) => void
}) {
  return (
    <NameDialog
      open={open}
      title="Arbeitsbereich anlegen"
      label="Name des neuen Arbeitsbereichs"
      maxLength={MAX_WORKSPACE_NAME_LENGTH}
      submitLabel="Arbeitsbereich anlegen"
      errorOf={(cause) =>
        cause instanceof ApiError ? cause.message : 'Der Arbeitsbereich konnte nicht angelegt werden.'
      }
      onSubmit={(name) =>
        createWorkspace(me.csrfToken, name).then((workspace) => {
          onClose()
          onCreated(workspace)
        })
      }
      onClose={onClose}
    />
  )
}
