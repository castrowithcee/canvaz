/** Builds the `.excalidraw` file of a scene; shared by the internal export and the automation API. */

import type { SceneSnapshot } from '../contracts/scene.js'
import type { ExcalidrawFile } from '../domain/board/excalidraw-file.js'
import { toExcalidrawFile } from '../domain/board/excalidraw-file.js'
import { visibleElements } from '../domain/board/reconcile.js'
import type { BoardId } from '../domain/board/model.js'
import type { AppContext } from './context.js'

/**
 * Images travel as embedded `data:` URLs, so a board is exactly one file. An image whose bytes are missing is
 * logged by id and left out: an empty reference would be worse than none.
 */
export async function buildExcalidrawExport(
  context: AppContext,
  boardId: BoardId,
  snapshot: SceneSnapshot,
): Promise<ExcalidrawFile> {
  const dataUrls = new Map<string, string>()
  for (const file of Object.values(snapshot.files)) {
    const asset = await context.boards.assets.findByFileId(boardId, file.id)
    const bytes = asset === null ? null : await context.storage.get(asset.storageKey)
    if (asset === null || bytes === null) {
      context.logger('warn', 'board.export.asset.missing', {
        boardId,
        fileId: file.id,
      })
      continue
    }
    dataUrls.set(file.id, `data:${asset.mimeType};base64,${Buffer.from(bytes).toString('base64')}`)
  }
  return toExcalidrawFile(
    visibleElements([...snapshot.elements]),
    snapshot.appState,
    Object.values(snapshot.files),
    dataUrls,
  )
}
