/**
 * Performance readouts at the bottom of the panel. The frame-time graph is fed imperatively from
 * the instance 'frame' event (no React state per frame); the numbers come from the 4 Hz stats.
 */

import { useLumiCells, useLumiCellsStats } from 'lumicells/react';
import { useEffect, useRef } from 'react';
import { Grid, Icon, Readout, StatsGraph, type StatsGraphHandle } from './ui';

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export function StatsBlock({ open, onToggle }: { open: boolean; onToggle(open: boolean): void }) {
  const instance = useLumiCells();
  const stats = useLumiCellsStats();
  const graph = useRef<StatsGraphHandle>(null);

  useEffect(() => {
    graph.current?.clear();
    if (!instance || !open) return;
    // `frame` reuses its payload object: read the number, never keep the object.
    return instance.on('frame', (e) => graph.current?.push(e.dt * 1000));
  }, [instance, open]);

  return (
    <div className="stand-stats" data-open={open}>
      <button
        type="button"
        className="stand-stats__head"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        <Icon name="chevron" size={12} className="stand-stats__chev" />
        <span>Статистика</span>
        <span className="stand-stats__summary">
          {stats ? `${fmt(stats.fps, 0)} fps · ${fmt(stats.frameMs)} мс` : '—'}
        </span>
      </button>
      {open && (
        <div className="stand-stats__body">
          <StatsGraph
            ref={graph}
            label="Кадр"
            unit="мс"
            min={0}
            guides={[16.67]}
            warnAbove={20}
            decimals={1}
            height={32}
          />
          <Grid columns={4} className="stand-stats__grid">
            <Readout label="FPS" value={stats ? fmt(stats.fps, 0) : '—'} />
            <Readout label="Кадр" value={stats ? `${fmt(stats.frameMs)} мс` : '—'} />
            <Readout label="CPU" value={stats ? `${fmt(stats.cpuMs, 2)} мс` : '—'} />
            <Readout label="GPU" value={stats?.gpuMs != null ? `${fmt(stats.gpuMs, 2)} мс` : '—'} />
            <Readout
              label="Качество"
              value={stats?.quality ?? '—'}
              tone={stats && stats.quality !== 'high' ? 'warn' : 'default'}
            />
            <Readout
              label="Масштаб"
              value={stats ? `×${fmt(stats.scale, 2)}` : '—'}
              tone={stats && stats.scale < 1 ? 'warn' : 'default'}
            />
            <Readout label="DPR" value={stats ? fmt(stats.dpr, 2) : '—'} />
            <Readout label="Мпикс" value={stats ? fmt(stats.pixels / 1e6, 2) : '—'} />
            <Readout label="Ячеек" value={stats ? `${stats.cols}×${stats.rows}` : '—'} />
            <Readout label="Лифты" value={stats ? String(stats.lifts) : '—'} />
            <Readout label="Влияния" value={stats ? String(stats.influences) : '—'} />
            <Readout
              label="Софт"
              value={stats?.softwareFallback ? 'да' : 'нет'}
              tone={stats?.softwareFallback ? 'warn' : 'default'}
            />
          </Grid>
        </div>
      )}
    </div>
  );
}
