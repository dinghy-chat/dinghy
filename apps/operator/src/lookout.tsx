/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { useFitScale } from "./gull.tsx";
import { createLookout, type LookoutKind } from "./lookout-scenes.ts";
import { type TextId, t } from "./text.ts";

const LABEL: Record<LookoutKind, TextId> = {
  lighthouse: "lookoutLighthouse",
  sonar: "lookoutSonar",
};

/**
 * A page's empty state with a moving pixel scene over its title and line: the lighthouse for
 * Analytics before its first numbers, the sonar for Visitors while nobody is on the site.
 */
export function Lookout({
  kind,
  className = "gull-pane",
  title,
  hint,
}: {
  kind: LookoutKind;
  className?: string;
  title: string;
  hint: string;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<ReturnType<typeof createLookout> | null>(null);
  const scale = useFitScale(pane);
  const firstScale = useRef(scale);
  useEffect(() => {
    if (canvas.current === null) return;
    const made = createLookout(canvas.current, kind, firstScale.current);
    scene.current = made;
    return () => {
      made.stop();
      scene.current = null;
    };
  }, [kind]);
  useEffect(() => scene.current?.setScale(scale), [scale]);
  return (
    <div className={className} ref={pane}>
      <div className="lookout-stage">
        <canvas ref={canvas} role="img" aria-label={t(LABEL[kind])} />
      </div>
      <h3>{title}</h3>
      <p className="gull-sub">{hint}</p>
    </div>
  );
}
