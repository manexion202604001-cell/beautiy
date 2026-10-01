export const RESOURCE_TYPE_LABEL: Record<string, string> = {
  spa_bed: 'スパベッド',
  shampoo: 'シャンプー台',
  chair: 'セット面',
  room: '個室',
};
export const resourceTypeLabel = (t: string) => RESOURCE_TYPE_LABEL[t] ?? t;
