/**
 * Ueberlagernde Bausteine: Dialog, Drawer und Aktionsmenue.
 *
 * ## Warum nativ
 *
 * Dialog und Drawer stehen auf dem `dialog`-Element. `showModal()` bringt Fokusfang, `Escape`, den
 * Hintergrund als `inert` und die Rueckgabe des Fokus an den Ausloeser mit - alles vom Browser und ohne
 * eigenen Nachbau. Ein Drawer ist derselbe Baustein mit anderer Flaeche; er ist kein zweites Konzept.
 *
 * Fuer das Aktionsmenue gibt es kein natives Element. Es entsteht deshalb hier: Ausloeser mit
 * `aria-expanded`, Liste als `role="menu"`, Pfeiltasten, `Home`/`End`, `Escape`, Klick nach aussen und
 * Fokusrueckgabe an den Ausloeser.
 *
 * Radix wurde dafuer geprueft und **nicht** genommen. Das React-DOM-Portal loest das Menue aus scrollenden
 * Containern; die kleine Rechnung unten haelt es im Viewport und klappt es am unteren Rand nach oben.
 * Typeahead oder eine weitere direkte Abhaengigkeit braucht dieser kurze Menuevertrag nicht.
 */

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button, IconButton } from './ui.js'

/**
 * Haelt ein `dialog`-Element im Gleichlauf mit `open`.
 *
 * `showModal()` und `close()` sind die einzigen Umschalter; die Anwendung setzt weder `open` als Attribut
 * noch eine eigene Sichtbarkeit. So bleibt die Plattform fuer Fokus und Tastatur zustaendig.
 */
function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  /**
   * Wahr, solange ein selbst ausgeloestes `close()` noch sein `close`-Ereignis erzeugt.
   *
   * Das Ereignis kommt bei **jedem** Schliessweg - auch bei dem, den die Ansicht gerade selbst angestossen
   * hat, weil sich ihr Zustand geaendert hat. Ohne diese Unterscheidung meldete die Ebene ein Schliessen
   * zurueck, das niemand verlangt hat: eine Informationsleiste, die beim Verbreitern vom Sheet zur
   * angedockten Spalte wird, verschwaende auf diesem Weg vollstaendig.
   */
  const selbstGeschlossen = useRef(false)

  useEffect(() => {
    const element = ref.current
    if (element === null) {
      return
    }
    if (open && !element.open) {
      element.showModal()
    } else if (!open && element.open) {
      selbstGeschlossen.current = true
      element.close()
    }
  }, [open])

  return { ref, selbstGeschlossen }
}

/** Meldet ein Schliessen nur, wenn es von aussen kam - Schaltflaeche, `Escape` oder Abdunklung. */
function reportClose(selbstGeschlossen: { current: boolean }, onClose: () => void): void {
  if (selbstGeschlossen.current) {
    selbstGeschlossen.current = false
    return
  }
  onClose()
}

/**
 * Modaler Dialog.
 *
 * `onClose` wird bei jedem Schliessweg gemeldet - Schaltflaeche, `Escape` und Klick auf die Abdunklung. Die
 * Ansicht setzt daraufhin ihren eigenen Zustand; der Fokus kehrt von selbst zum Ausloeser zurueck.
 */
export function Dialog({
  open,
  title,
  danger = false,
  onClose,
  children,
}: {
  readonly open: boolean
  readonly title: string
  /** Nur fuer das, was sich nicht zuruecknehmen laesst. */
  readonly danger?: boolean
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  const { ref, selbstGeschlossen } = useModal(open)
  const titleId = useId()

  return (
    <dialog
      ref={ref}
      className={danger ? 'dialog dialog--danger' : 'dialog'}
      aria-labelledby={titleId}
      onClose={() => {
        reportClose(selbstGeschlossen, onClose)
      }}
      onClick={(event) => {
        // Ein Klick trifft das `dialog` selbst nur ausserhalb seines Inhalts - das ist die Abdunklung.
        if (event.target === ref.current) {
          onClose()
        }
      }}
    >
      <div className="dialog__head">
        <h2 id={titleId}>{title}</h2>
        <IconButton label="Dialog schliessen" icon={X} variant="quiet" onClick={onClose} />
      </div>
      <div className="dialog__body">{children}</div>
    </dialog>
  )
}

/**
 * Seitliche Ebene auf demselben nativen Element.
 *
 * `className` gibt der Ebene ihre Flaeche. Die Huelle nutzt das, um ihre Seitenleiste auf breiten Fenstern
 * per CSS zu einer gewoehnlichen Spalte zu machen: derselbe Knoten, dieselbe Navigation, kein zweiter Baum.
 * Die Kopfzeile der Ebene ist dort ausgeblendet.
 */
export function Drawer({
  id,
  open,
  title,
  className,
  onClose,
  children,
}: {
  /** Ziel des `aria-controls` am Ausloeser. */
  readonly id: string
  readonly open: boolean
  readonly title: string
  readonly className: string
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  const { ref, selbstGeschlossen } = useModal(open)

  return (
    <dialog
      id={id}
      ref={ref}
      className={className}
      aria-label={title}
      onClose={() => {
        reportClose(selbstGeschlossen, onClose)
      }}
    >
      <div className="drawer__head">
        <p className="sidebar__title">{title}</p>
        <IconButton label={`${title} schliessen`} icon={X} variant="quiet" onClick={onClose} />
      </div>
      {children}
    </dialog>
  )
}

/* --------------------------------------------------------- Aktionsmenue */

/**
 * Der naechste Eintrag eines Menues zu einer Taste.
 *
 * Reine Rechnung ohne DOM: `null` heisst "diese Taste gehoert nicht dem Menue". Die Liste ist ein Ring -
 * unter dem letzten Eintrag steht wieder der erste.
 */
export function nextMenuIndex(current: number, count: number, key: string): number | null {
  if (count === 0) {
    return null
  }
  switch (key) {
    // `current < 0` heisst: der Fokus steht noch auf dem Ausloeser, das Menue beginnt an seinem Rand.
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Positioniert ein Menue unter seinem Ausloeser oder, wenn dort kein Platz ist, darueber. */
export function menuPosition(
  trigger: { readonly top: number; readonly right: number; readonly bottom: number },
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number; readonly maxHeight: number } {
  const margin = 8
  const gap = 4
  const maxWidth = Math.max(0, viewport.width - margin * 2)
  const width = Math.min(menu.width, maxWidth)
  const maxHeight = Math.max(0, viewport.height - margin * 2)
  const height = Math.min(menu.height, maxHeight)
  const left = Math.min(
    Math.max(margin, trigger.right - width),
    Math.max(margin, viewport.width - margin - width),
  )
  const below = trigger.bottom + gap
  const above = trigger.top - gap - height
  const top =
    below + height <= viewport.height - margin
      ? below
      : above >= margin
        ? above
        : Math.max(margin, viewport.height - margin - height)

  return { left, top, maxHeight }
}

const MenuContext = createContext<((focusTrigger?: boolean) => void) | null>(null)

/** Ein Eintrag des Menues. Er schliesst das Menue, bevor er seine Aktion ausloest. */
export function MenuItem({
  icon: Icon,
  danger = false,
  disabled = false,
  onSelect,
  children,
}: {
  readonly icon?: LucideIcon
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
  readonly children: ReactNode
}) {
  const close = useContext(MenuContext)

  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        className={danger ? 'menu__item menu__item--danger' : 'menu__item'}
        disabled={disabled}
        onClick={() => {
          close?.()
          onSelect()
        }}
      >
        {Icon !== undefined && <Icon size={16} aria-hidden="true" />}
        {children}
      </button>
    </li>
  )
}

/**
 * Ein Eintrag, der zu einer Adresse fuehrt.
 *
 * Bewusst ein echter Link: er behaelt `href`, laesst sich in einem neuen Tab oeffnen und traegt
 * `aria-current`, wenn seine Ansicht gerade sichtbar ist. `children` ist der fertige Link der Ansicht.
 */
export function MenuLinkItem({ children }: { readonly children: ReactNode }) {
  const close = useContext(MenuContext)

  return (
    <li
      role="none"
      onClick={() => {
        // Der Link navigiert selbst; das Menue muss danach nur noch verschwinden. Der Fokus bleibt dort, wo
        // ihn die neue Ansicht setzt, und wird nicht zum Ausloeser zurueckgezwungen.
        close?.(false)
      }}
    >
      {children}
    </li>
  )
}

/**
 * Aktionsmenue.
 *
 * Es sammelt die Nebenaktionen eines Bereichs, damit neben der Hauptaktion keine Reihe gleich gewichteter
 * Schaltflaechen steht. Geoeffnet wird mit Klick, `Enter`, `Leertaste` oder Pfeil nach unten.
 */
export function Menu({
  id,
  label,
  icon,
  text,
  children,
}: {
  /**
   * Kennung des Ausloesers.
   *
   * Sie macht ihn wiederfindbar, nachdem die Ansicht dazwischen etwas anderes gezeigt hat - etwa eine
   * Eingabe im Fluss der Liste, die den Knopf so lange ersetzt. Ohne diesen Fall braucht ein Menue sie nicht.
   */
  readonly id?: string
  readonly label: string
  readonly icon: LucideIcon
  /**
   * Beschriftung des Ausloesers.
   *
   * Ohne sie besteht er allein aus dem Symbol und traegt `label` als zugaenglichen Namen - die Form fuer
   * ein Kontextmenue an einem Eintrag. Mit ihr ist er eine gewoehnliche Schaltflaeche, deren Text den
   * aktuellen Stand nennt (etwa den gewaehlten Arbeitsbereich); `label` bleibt daneben ihr voller Name.
   */
  readonly text?: string
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const menuId = useId()

  const close = useCallback((focusTrigger = true) => {
    setOpen(false)
    if (focusTrigger) {
      triggerRef.current?.focus()
    }
  }, [])

  const items = (): readonly HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const place = (): void => {
      const trigger = triggerRef.current
      const list = listRef.current
      if (trigger === null || list === null) {
        return
      }
      const box = trigger.getBoundingClientRect()
      const next = menuPosition(
        box,
        { width: list.offsetWidth, height: list.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      )
      setPosition({ left: next.left, top: next.top, maxHeight: next.maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, children])

  // Ein Klick oder ein Fokus ausserhalb schliesst das Menue - ohne den Fokus zurueckzuholen.
  useEffect(() => {
    if (!open) {
      return
    }
    const dismiss = (event: Event): void => {
      const target = event.target
      if (
        target instanceof Node &&
        (rootRef.current?.contains(target) === true || listRef.current?.contains(target) === true)
      ) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
    }
  }, [open])

  // Beim Oeffnen steht der Fokus auf dem ersten Eintrag; das Menue ist damit sofort mit Pfeilen bedienbar.
  // Erst wenn es platziert ist: bis dahin ist die Liste unsichtbar und nimmt keinen Fokus an.
  const placed = position !== null
  useEffect(() => {
    if (open && placed) {
      listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    }
  }, [open, placed])

  return (
    <div
      className="menu"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          close()
          return
        }
        if (!open) {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
          return
        }
        const entries = items()
        const current = entries.findIndex((entry) => entry === document.activeElement)
        const next = nextMenuIndex(current, entries.length, event.key)
        if (next !== null) {
          event.preventDefault()
          entries[next]?.focus()
        }
      }}
    >
      {text === undefined ? (
        <IconButton
          ref={triggerRef}
          id={id}
          label={label}
          icon={icon}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            setOpen((was) => !was)
          }}
        />
      ) : (
        <Button
          ref={triggerRef}
          id={id}
          icon={icon}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          extraClass="menu__trigger"
          onClick={() => {
            setOpen((was) => !was)
          }}
        >
          {text}
        </Button>
      )}
      {open &&
        createPortal(
          <MenuContext.Provider value={close}>
            <ul
              className="menu__list"
              id={menuId}
              ref={listRef}
              role="menu"
              aria-label={label}
              style={position === null ? { visibility: 'hidden' } : position}
            >
              {children}
            </ul>
          </MenuContext.Provider>,
          document.body,
        )}
    </div>
  )
}
