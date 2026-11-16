/** @jsxImportSource react */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { loadTexts } from "../../../packages/widget/src/locale.ts";
import {
  clearPreview,
  type PreviewProps,
  renderPreview,
} from "../../../packages/widget/src/preview.tsx";
import type { Locale } from "../../../packages/widget/src/shared.ts";
import { setLanguage, type Texts } from "../../../packages/widget/src/text.ts";
import { t } from "./text.ts";

/**
 * The chat as visitors see it, in `locale`, drawn by the widget's own code in a Shadow DOM. It is a
 * picture: its sample buttons do nothing, so nothing can reach them.
 */
export function WidgetDrawing({ locale, ...props }: PreviewProps & { locale: Locale }) {
  const host = useRef<HTMLDivElement>(null);
  const [texts, setTexts] = useState<{ locale: Locale; texts: Partial<Texts> } | null>(null);
  useEffect(() => {
    let current = true;
    void loadTexts("/widget/", locale).then((loaded) => {
      if (current) setTexts({ locale, texts: loaded });
    });
    return () => {
      current = false;
    };
  }, [locale]);
  // On every render, so each change in the form shows at once.
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    if (texts?.locale === locale) setLanguage(locale, texts.texts);
    renderPreview(shadow, props);
  });
  // With the page, so the sea's animation frames and listeners stop.
  useEffect(() => {
    const shadow = host.current?.shadowRoot;
    return () => {
      if (shadow) clearPreview(shadow);
    };
  }, []);
  return <div ref={host} inert />;
}

/**
 * The preview's box, which stays in view beside a form. On a phone it sits above the form, and
 * folds away. `controls` sit over the drawing, such as the visitor's device, and `note` under it.
 */
export function PreviewFrame({
  controls,
  note,
  children,
}: {
  controls: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  const [folded, setFolded] = useState(false);
  return (
    <section className="widget-preview" aria-label={t("previewTitle")} data-folded={folded}>
      <div className="preview-bar">
        <h3>{t("previewTitle")}</h3>
        <button
          type="button"
          className="text-button preview-fold"
          onClick={() => setFolded(!folded)}
        >
          {t(folded ? "previewShow" : "previewHide")}
        </button>
      </div>
      <div className="preview-body">
        {controls}
        <div className="preview-stage">{children}</div>
        {note}
      </div>
    </section>
  );
}
