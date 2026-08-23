// Helper to calculate smooth dynamic curved Bézier connector paths with fixed logical port routing
export const calculateConnectorPath = (fromNode, toNode, dimensionsMap = {}, branchType = 'down') => {
  if (!fromNode || !toNode) return { d: '', x1: 0, y1: 0, x2: 0, y2: 0 };
  const fromDim = (dimensionsMap && dimensionsMap[fromNode.id]) || { width: 170, height: 48 };
  const toDim = (dimensionsMap && dimensionsMap[toNode.id]) || { width: 170, height: 48 };

  const fx = typeof fromNode.x === 'number' ? fromNode.x : 650;
  const fy = typeof fromNode.y === 'number' ? fromNode.y : 260;
  const fw = fromDim.width || 170;
  const fh = fromDim.height || 48;
  const fcx = fx + fw / 2;
  const fcy = fy + fh / 2;

  const tx = typeof toNode.x === 'number' ? toNode.x : 650;
  const ty = typeof toNode.y === 'number' ? toNode.y : 450;
  const tw = toDim.width || 170;
  const th = toDim.height || 48;
  const tcx = tx + tw / 2;
  const tcy = ty + th / 2;

  // 4 Connection Ports on parent and child
  const portsFrom = {
    right: { x: fx + fw, y: fcy, dir: { x: 1, y: 0 } },
    left: { x: fx, y: fcy, dir: { x: -1, y: 0 } },
    bottom: { x: fcx, y: fy + fh, dir: { x: 0, y: 1 } },
    top: { x: fcx, y: fy, dir: { x: 0, y: -1 } }
  };

  const portsTo = {
    right: { x: tx + tw, y: tcy, dir: { x: 1, y: 0 } },
    left: { x: tx, y: tcy, dir: { x: -1, y: 0 } },
    bottom: { x: tcx, y: ty + th, dir: { x: 0, y: 1 } },
    top: { x: tcx, y: ty, dir: { x: 0, y: -1 } }
  };

  let p1, p2;
  const normBranch = (branchType === 'left') ? 'left' :
                     (branchType === 'up') ? 'up' :
                     (branchType === 'down' || branchType === 'bottom') ? 'down' : 'right';

  if (normBranch === 'right') {
    // Parent RIGHT port -> Child LEFT port
    p1 = portsFrom.right;
    p2 = portsTo.left;
  } else if (normBranch === 'left') {
    // Parent LEFT port -> Child RIGHT port
    p1 = portsFrom.left;
    p2 = portsTo.right;
  } else if (normBranch === 'up') {
    // Parent TOP port -> Child BOTTOM port
    p1 = portsFrom.top;
    p2 = portsTo.bottom;
  } else {
    // Parent BOTTOM port -> Child TOP port
    p1 = portsFrom.bottom;
    p2 = portsTo.top;
  }

  // Calculate dynamic control points for smooth natural curve originating from logical port directions
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const curvature = Math.max(35, Math.min(220, dist * 0.45));

  const c1x = p1.x + p1.dir.x * curvature;
  const c1y = p1.y + p1.dir.y * curvature;
  const c2x = p2.x + p2.dir.x * curvature;
  const c2y = p2.y + p2.dir.y * curvature;

  const d = `M ${p1.x} ${p1.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;

  return {
    d,
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y
  };
};
