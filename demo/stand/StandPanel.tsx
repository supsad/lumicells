/**
 * The right-hand panel shell: search, advanced switch, section state and the stats footer.
 * It owns its own state and is memoized, so config edits (which re-render the app root) only
 * touch the rows that show the changed values.
 */

import { memo, useMemo, useState } from 'react';
import { useT } from './i18n';
import { filterModel, getPanelModel } from './model';
import type { Prefs } from './prefs';
import { StatsBlock } from './StatsBlock';
import { SchemaPanel, SectionStateContext, useSectionState } from './schema-panel';
import { IconButton, Panel, SearchInput, Switch } from './ui';

interface StandPanelProps {
  prefs: Prefs;
  patchPrefs(patch: Partial<Prefs>): void;
}

export const StandPanel = memo(function StandPanel({ prefs, patchPrefs }: StandPanelProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  // Search results are shown expanded, whatever the saved section state.
  const sections = useSectionState(query.trim() !== '');
  const matchCount = useMemo(
    () => filterModel(getPanelModel(), query, prefs.showAdvanced).count,
    [query, prefs.showAdvanced],
  );

  return (
    <Panel
      title="LumiCells"
      subtitle={t.panel.subtitle}
      width={380}
      collapsed={prefs.panelCollapsed}
      onCollapsedChange={(panelCollapsed) => patchPrefs({ panelCollapsed })}
      headerActions={
        <>
          <IconButton
            icon="plus"
            label={t.panel.expandAll}
            size="sm"
            onClick={() => sections.setAll(true)}
          />
          <IconButton
            icon="minus"
            label={t.panel.collapseAll}
            size="sm"
            onClick={() => sections.setAll(false)}
          />
        </>
      }
      search={
        <div className="stand-search">
          <SearchInput value={query} onChange={setQuery} count={matchCount} />
          <div className="stand-adv">
            <Switch
              id="stand-adv"
              checked={prefs.showAdvanced}
              onChange={(showAdvanced) => patchPrefs({ showAdvanced })}
            />
            <label htmlFor="stand-adv">{t.panel.showAdvanced}</label>
          </div>
        </div>
      }
      footer={
        <StatsBlock open={prefs.statsOpen} onToggle={(statsOpen) => patchPrefs({ statsOpen })} />
      }
    >
      <SectionStateContext.Provider value={sections.state}>
        <SchemaPanel query={query} showAdvanced={prefs.showAdvanced} />
      </SectionStateContext.Provider>
    </Panel>
  );
});
