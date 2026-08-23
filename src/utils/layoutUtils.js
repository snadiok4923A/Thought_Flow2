export const computeFormattedGroupPositions = (currentParent, items, direction, layout, dimMap = {}) => {
  if (!currentParent || !items || items.length < 2) return {};

  const px = typeof currentParent.x === 'number' ? currentParent.x : 650;
  const py = typeof currentParent.y === 'number' ? currentParent.y : 260;
  
  const parentW = dimMap[currentParent.id]?.w || 160;
  const parentH = dimMap[currentParent.id]?.h || 40;

  const spacingX = layout.spacingX || 60;
  const spacingY = layout.spacingY || 40;
  const gapX = layout.gapX || 30;
  const gapY = layout.gapY || 20;

  const updates = {};
  
  if (direction === 'down') {
    // Horizontal row below parent
    let totalWidth = 0;
    const widths = items.map(item => {
      const w = dimMap[item.id]?.w || 160;
      totalWidth += w;
      return w;
    });
    totalWidth += (items.length - 1) * gapX;
    
    let startX = px + (parentW / 2) - (totalWidth / 2);
    const y = py + parentH + spacingY;
    
    items.forEach((item, index) => {
      updates[item.id] = { ...item, x: Math.round(startX), y: Math.round(y) };
      startX += widths[index] + gapX;
    });
  } else {
    // Vertical column to the right of parent
    let totalHeight = 0;
    const heights = items.map(item => {
      const h = dimMap[item.id]?.h || 40;
      totalHeight += h;
      return h;
    });
    totalHeight += (items.length - 1) * gapY;

    const x = px + parentW + spacingX;
    let startY = py + (parentH / 2) - (totalHeight / 2);

    items.forEach((item, index) => {
      updates[item.id] = { ...item, x: Math.round(x), y: Math.round(startY) };
      startY += heights[index] + gapY;
    });
  }
  
  return updates;
};
