import { FieldConfig, formattedValueToString, getValueFormat, GrafanaTheme2, ThresholdsMode } from '@grafana/data';
import { VizLegendItem } from '@grafana/ui';

export function getThresholdItems(fieldConfig: FieldConfig, theme: GrafanaTheme2, unit: string): VizLegendItem[] {
  const items: VizLegendItem[] = [];
  const thresholds = fieldConfig.thresholds;
  if (!thresholds || !thresholds.steps.length) {
    return items;
  }

  const steps = thresholds.steps;
  const disp = getValueFormat(thresholds.mode === ThresholdsMode.Percentage ? 'percent' : fieldConfig.unit ?? '');

  const fmt = (v: number) => formattedValueToString(disp(v));

  for (let i = 1; i <= steps.length; i++) {
    const step = steps[i - 1];
    let startVal = "";
    let endVal = "";
    let setVals = !((i===1)||(i===steps.length));
    if(i===1) {
      startVal = "<";
      endVal = fmt(steps[i].value)+unit;
    }
    if(i === steps.length) {
      startVal = ">";
      endVal = fmt(steps[i-1].value)+unit;
    }
    if(setVals) {
      startVal = fmt(steps[i-1].value)+unit;
      endVal = "-"+fmt(steps[i].value)+unit;  
    }
    items.push({
      label: `${startVal}${endVal}`,
      color: theme.visualization.getColorByName(step.color),
      yAxis: 1,
    });
  }

  return items;
}
