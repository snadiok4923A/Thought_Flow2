// Helper to check if HTML / notes content contains actual text written by user
export const hasTextContent = (htmlOrText) => {
  if (!htmlOrText || typeof htmlOrText !== 'string') return false;
  const clean = htmlOrText
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .trim();
  return clean.length > 0;
};

// Helper to deeply snapshot exact mind-map state (hierarchy, coordinates, notes, photos, sketches, collapse state)
export const cloneMindMapState = (tree, collapsedSet) => {
  if (!tree) return null;
  return {
    treeData: JSON.parse(JSON.stringify(tree)),
    collapsedNodeIds: Array.from(collapsedSet || [])
  };
};

// Helper to extract a node's logical side ('right' | 'left' | 'up' | 'down')
export const getChildLogicalSide = (child, fallbackIsRight = false) => {
  if (!child) return 'down';
  if (child.side) {
    const s = String(child.side).toLowerCase();
    if (s === 'right') return 'right';
    if (s === 'left') return 'left';
    if (s === 'up') return 'up';
    if (s === 'down' || s === 'bottom') return 'down';
  }
  return fallbackIsRight ? 'right' : 'down';
};

// Helper to classify direct children of a parent into directional buckets based on persistent logical side
export const getChildrenByDirection = (parent) => {
  if (!parent) return { right: [], left: [], up: [], down: [] };
  const groups = { right: [], left: [], up: [], down: [] };

  (parent.rightChildren || []).forEach(child => {
    const side = getChildLogicalSide(child, true);
    if (groups[side]) {
      groups[side].push(child);
    } else {
      groups.right.push(child);
    }
  });

  (parent.children || []).forEach(child => {
    const side = getChildLogicalSide(child, false);
    if (groups[side]) {
      groups[side].push(child);
    } else {
      groups.down.push(child);
    }
  });

  return groups;
};

// Helper to shift a node and all its descendants by (dx, dy)
export const shiftNodeAndDescendants = (node, dx, dy) => {
  if (!node) return node;
  const nextX = typeof node.x === 'number' ? Math.round(node.x + dx) : 650;
  const nextY = typeof node.y === 'number' ? Math.round(node.y + dy) : 260;
  return {
    ...node,
    x: nextX,
    y: nextY,
    children: (node.children || []).map(child => shiftNodeAndDescendants(child, dx, dy)),
    rightChildren: (node.rightChildren || []).map(child => shiftNodeAndDescendants(child, dx, dy))
  };
};

// Helper to apply updated child nodes to a parent inside the tree hierarchy
export const applyFormattedChildrenToTree = (root, parentId, updatedChildrenMap) => {
  if (!root) return root;
  if (root.id === parentId) {
    const nextChildren = (root.children || []).map(c => updatedChildrenMap[c.id] || c);
    const nextRightChildren = (root.rightChildren || []).map(c => updatedChildrenMap[c.id] || c);
    return {
      ...root,
      children: nextChildren,
      rightChildren: nextRightChildren
    };
  }
  return {
    ...root,
    children: (root.children || []).map(c => applyFormattedChildrenToTree(c, parentId, updatedChildrenMap)),
    rightChildren: (root.rightChildren || []).map(c => applyFormattedChildrenToTree(c, parentId, updatedChildrenMap))
  };
};

// Helper to apply updated child nodes across one or multiple parents throughout the tree
export const applyMultipleFormattedChildrenToTree = (root, updatedChildrenMap) => {
  if (!root || !updatedChildrenMap || Object.keys(updatedChildrenMap).length === 0) return root;

  const nextChildren = (root.children || []).map(c => {
    if (updatedChildrenMap[c.id]) {
      return updatedChildrenMap[c.id];
    }
    return applyMultipleFormattedChildrenToTree(c, updatedChildrenMap);
  });

  const nextRightChildren = (root.rightChildren || []).map(c => {
    if (updatedChildrenMap[c.id]) {
      return updatedChildrenMap[c.id];
    }
    return applyMultipleFormattedChildrenToTree(c, updatedChildrenMap);
  });

  return {
    ...root,
    children: nextChildren,
    rightChildren: nextRightChildren
  };
};

// Helper to compute formatted layout positions for a specific set of children of a parent in a direction
export const computeFormattedGroupPositions = (currentParent, items, direction, layout, dimMap = {}) => {
  if (!currentParent || !items || items.length < 2) return {};

  const px = typeof currentParent.x === 'number' ? currentParent.x : 650;
  const py = typeof currentParent.y === 'number' ? currentParent.y : 260;
  const pWidth = dimMap[currentParent.id]?.width || 220;
  const pHeight = dimMap[currentParent.id]?.height || 64;
  const pCenterX = px + pWidth / 2;
  const pCenterY = py + pHeight / 2;

  const updatedChildrenMap = {};

  if (layout === 'compact' && direction === 'down') {
    // DOWN + COMPACT: TWO-HORIZONTAL-ROW GRID (preserves natural creation order)
    const count = items.length;
    const topRowCount = Math.ceil(count / 2);
    const row1 = items.slice(0, topRowCount);
    const row2 = items.slice(topRowCount);

    const gapX = 20;
    const gapY = 16;
    const offsetFromParentY = 65;

    // Calculate Row 1 total width and max height
    let totalWidth1 = 0;
    let maxHeight1 = 0;
    row1.forEach((item, idx) => {
      const w = dimMap[item.id]?.width || 200;
      const h = dimMap[item.id]?.height || 56;
      totalWidth1 += w;
      if (h > maxHeight1) maxHeight1 = h;
      if (idx > 0) totalWidth1 += gapX;
    });

    // Calculate Row 2 total width
    let totalWidth2 = 0;
    row2.forEach((item, idx) => {
      const w = dimMap[item.id]?.width || 200;
      totalWidth2 += w;
      if (idx > 0) totalWidth2 += gapX;
    });

    // Position Row 1 (centered horizontally relative to parent pCenterX)
    let currentX1 = Math.round(pCenterX - totalWidth1 / 2);
    const targetY1 = Math.round(py + pHeight + offsetFromParentY);

    row1.forEach(item => {
      const w = dimMap[item.id]?.width || 200;
      const oldX = item.x ?? 650;
      const oldY = item.y ?? 260;
      const newX = Math.round(currentX1);
      const newY = targetY1;
      const dx = newX - oldX;
      const dy = newY - oldY;

      updatedChildrenMap[item.id] = shiftNodeAndDescendants(item, dx, dy);
      currentX1 += w + gapX;
    });

    // Position Row 2 (centered horizontally relative to parent pCenterX / underneath Row 1)
    if (row2.length > 0) {
      let currentX2 = Math.round(pCenterX - totalWidth2 / 2);
      const targetY2 = targetY1 + maxHeight1 + gapY;

      row2.forEach(item => {
        const w = dimMap[item.id]?.width || 200;
        const oldX = item.x ?? 650;
        const oldY = item.y ?? 260;
        const newX = Math.round(currentX2);
        const newY = targetY2;
        const dx = newX - oldX;
        const dy = newY - oldY;

        updatedChildrenMap[item.id] = shiftNodeAndDescendants(item, dx, dy);
        currentX2 += w + gapX;
      });
    }
  } else if (layout === 'compact') {
    // Group into rows of 2 nodes (preserves natural creation order)
    const rows = [];
    for (let i = 0; i < items.length; i += 2) {
      if (i + 1 < items.length) {
        rows.push([items[i], items[i + 1]]);
      } else {
        rows.push([items[i]]);
      }
    }

    const gapX = 24;
    const gapY = 16;
    const offsetFromParentX = 80;
    const offsetFromParentY = 65;

    let col0Width = 0;
    let col1Width = 0;

    rows.forEach(row => {
      if (row.length === 2) {
        const w0 = dimMap[row[0].id]?.width || 200;
        const w1 = dimMap[row[1].id]?.width || 200;
        if (w0 > col0Width) col0Width = w0;
        if (w1 > col1Width) col1Width = w1;
      } else {
        const w = dimMap[row[0].id]?.width || 200;
        if (col0Width === 0) col0Width = w;
        if (col1Width === 0) col1Width = w;
      }
    });
    if (col0Width === 0) col0Width = 200;
    if (col1Width === 0) col1Width = 200;

    const totalGroupWidth = col0Width + gapX + col1Width;
    const rowHeights = rows.map(row => {
      let maxH = 0;
      row.forEach(item => {
        const h = dimMap[item.id]?.height || 56;
        if (h > maxH) maxH = h;
      });
      return maxH;
    });

    const totalGroupHeight = rowHeights.reduce((acc, h) => acc + h, 0) + (rows.length - 1) * gapY;

    let groupStartX = 0;
    let groupStartY = 0;

    if (direction === 'right') {
      groupStartX = Math.round(px + pWidth + offsetFromParentX);
      groupStartY = Math.round(pCenterY - totalGroupHeight / 2);
    } else if (direction === 'left') {
      groupStartX = Math.round(px - offsetFromParentX - totalGroupWidth);
      groupStartY = Math.round(pCenterY - totalGroupHeight / 2);
    } else if (direction === 'up') {
      groupStartX = Math.round(pCenterX - totalGroupWidth / 2);
      groupStartY = Math.round(py - offsetFromParentY - totalGroupHeight);
    }

    let currY = groupStartY;
    rows.forEach((row, rIdx) => {
      const rowH = rowHeights[rIdx];
      if (row.length === 2) {
        const node0 = row[0];
        const node1 = row[1];
        const n0X = groupStartX;
        const n0Y = currY;
        const n1X = groupStartX + col0Width + gapX;
        const n1Y = currY;

        const dx0 = n0X - (node0.x ?? 650);
        const dy0 = n0Y - (node0.y ?? 260);
        const dx1 = n1X - (node1.x ?? 650);
        const dy1 = n1Y - (node1.y ?? 260);

        updatedChildrenMap[node0.id] = shiftNodeAndDescendants(node0, dx0, dy0);
        updatedChildrenMap[node1.id] = shiftNodeAndDescendants(node1, dx1, dy1);
      } else {
        const node0 = row[0];
        const nodeW = dimMap[node0.id]?.width || 200;
        const n0X = Math.round(groupStartX + (totalGroupWidth - nodeW) / 2);
        const n0Y = currY;
        const dx0 = n0X - (node0.x ?? 650);
        const dy0 = n0Y - (node0.y ?? 260);

        updatedChildrenMap[node0.id] = shiftNodeAndDescendants(node0, dx0, dy0);
      }
      currY += rowH + gapY;
    });
  } else {
    // List layout (preserves natural creation order)
    if (direction === 'right' || direction === 'left') {
      const gapY = 26;
      const offsetFromParentX = 90;

      let totalHeight = 0;
      items.forEach((item, idx) => {
        const h = dimMap[item.id]?.height || 56;
        totalHeight += h;
        if (idx > 0) totalHeight += gapY;
      });

      let currentY = Math.round(pCenterY - totalHeight / 2);

      items.forEach(item => {
        const w = dimMap[item.id]?.width || 200;
        const h = dimMap[item.id]?.height || 56;
        const oldX = item.x ?? 650;
        const oldY = item.y ?? 260;

        let newX;
        if (direction === 'right') {
          newX = Math.round(px + pWidth + offsetFromParentX);
        } else {
          newX = Math.round(px - offsetFromParentX - w);
        }
        const newY = Math.round(currentY);
        const dx = newX - oldX;
        const dy = newY - oldY;

        updatedChildrenMap[item.id] = shiftNodeAndDescendants(item, dx, dy);
        currentY += h + gapY;
      });
    } else if (direction === 'down' || direction === 'up') {
      const gapX = 36;
      const offsetFromParentY = 85;

      let totalWidth = 0;
      let maxHeight = 0;
      items.forEach((item, idx) => {
        const w = dimMap[item.id]?.width || 200;
        const h = dimMap[item.id]?.height || 56;
        totalWidth += w;
        if (h > maxHeight) maxHeight = h;
        if (idx > 0) totalWidth += gapX;
      });

      let currentX = Math.round(pCenterX - totalWidth / 2);
      const targetY = direction === 'down'
        ? Math.round(py + pHeight + offsetFromParentY)
        : Math.round(py - maxHeight - offsetFromParentY);

      items.forEach(item => {
        const w = dimMap[item.id]?.width || 200;
        const oldX = item.x ?? 650;
        const oldY = item.y ?? 260;
        const newX = Math.round(currentX);
        const newY = targetY;
        const dx = newX - oldX;
        const dy = newY - oldY;

        updatedChildrenMap[item.id] = shiftNodeAndDescendants(item, dx, dy);
        currentX += w + gapX;
      });
    }
  }

  return updatedChildrenMap;
};

// Helper to format file size
export const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

// Shared helper to read files (images/screenshots or text) from system clipboard
export const readClipboardAsFiles = async () => {
  if (!navigator.clipboard) return null;
  // 1. Try reading images/blobs first
  if (navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      const filesToImport = [];
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const ext = type.split('/')[1] || 'png';
            const fileObj = new File(
              [blob], 
              `Screenshot_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`, 
              { type }
            );
            filesToImport.push(fileObj);
          }
        }
      }
      if (filesToImport.length > 0) {
        return filesToImport;
      }
    } catch {
      // Fallback to text
    }
  }

  // 2. Try reading plain text
  if (navigator.clipboard.readText) {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      const cleanText = text.trim();
      const firstLine = cleanText.split('\n')[0].replace(/[^\w\s-]/gi, '').trim().slice(0, 24);
      const title = firstLine.length > 2 ? `${firstLine}.txt` : `Pasted_Note_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
      const blob = new Blob([cleanText], { type: 'text/plain;charset=utf-8' });
      const fileObj = new File([blob], title, { type: 'text/plain' });
      return [fileObj];
    }
  }
  return null;
};

// Helper to ensure all nodes have valid canvas x/y positions with compact close branch distances
export const ensureNodePositions = (node, originX = 650, originY = 260, defaultSide = null) => {
  if (!node) return null;
  const currentX = typeof node.x === 'number' ? node.x : originX;
  const currentY = typeof node.y === 'number' ? node.y : originY;
  const side = node.side ? getChildLogicalSide(node) : (defaultSide || undefined);

  const rightChildren = (node.rightChildren || []).map((child, idx) => {
    const defaultY = currentY + ((idx % 3) * 14 - 14);
    return ensureNodePositions(child, currentX + 180, defaultY, child.side ? getChildLogicalSide(child, true) : 'right');
  });

  const children = (node.children || []).map((child, idx) => {
    const defaultX = currentX + ((idx % 3) * 16 - 16);
    return ensureNodePositions(child, defaultX, currentY + 95, child.side ? getChildLogicalSide(child, false) : 'down');
  });

  return {
    ...node,
    side,
    x: currentX,
    y: currentY,
    rightChildren,
    children
  };
};

// Helper to add a node in any logical direction ('right' | 'left' | 'up' | 'bottom'/'down')
export const addNodeInDirection = (root, targetNodeId, direction = 'bottom', newText = '') => {
  if (!root) return { updatedTree: null, newNode: null };
  let createdNode = null;
  const normDir = (direction === 'right') ? 'right' :
                  (direction === 'left') ? 'left' :
                  (direction === 'up') ? 'up' : 'down';

  const insert = (node) => {
    if (node.id === targetNodeId) {
      const parentX = typeof node.x === 'number' ? node.x : 650;
      const parentY = typeof node.y === 'number' ? node.y : 260;

      let newX = parentX;
      let newY = parentY;

      if (normDir === 'right') {
        const existingRight = node.rightChildren || [];
        const count = existingRight.length;
        newX = parentX + 180;
        newY = parentY + ((count % 3) * 14 - 14);
        const newNode = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          text: newText,
          notes: '',
          drawing: null,
          images: [],
          side: 'right',
          x: newX,
          y: newY,
          rightChildren: [],
          children: []
        };
        createdNode = newNode;
        return { ...node, rightChildren: [...existingRight, newNode] };
      } else if (normDir === 'left') {
        const existingRight = node.rightChildren || [];
        const count = existingRight.length;
        newX = parentX - 180;
        newY = parentY + ((count % 3) * 14 - 14);
        const newNode = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          text: newText,
          notes: '',
          drawing: null,
          images: [],
          side: 'left',
          x: newX,
          y: newY,
          rightChildren: [],
          children: []
        };
        createdNode = newNode;
        return { ...node, rightChildren: [...existingRight, newNode] };
      } else if (normDir === 'up') {
        const existingBottom = node.children || [];
        const count = existingBottom.length;
        newX = parentX + ((count % 3) * 16 - 16);
        newY = parentY - 95;
        const newNode = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          text: newText,
          notes: '',
          drawing: null,
          images: [],
          side: 'up',
          x: newX,
          y: newY,
          rightChildren: [],
          children: []
        };
        createdNode = newNode;
        return { ...node, children: [...existingBottom, newNode] };
      } else {
        const existingBottom = node.children || [];
        const count = existingBottom.length;
        newX = parentX + ((count % 3) * 16 - 16);
        newY = parentY + 95;
        const newNode = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          text: newText,
          notes: '',
          drawing: null,
          images: [],
          side: 'down',
          x: newX,
          y: newY,
          rightChildren: [],
          children: []
        };
        createdNode = newNode;
        return { ...node, children: [...existingBottom, newNode] };
      }
    }
    return {
      ...node,
      rightChildren: (node.rightChildren || []).map(insert),
      children: (node.children || []).map(insert)
    };
  };

  return {
    updatedTree: insert(root),
    newNode: createdNode
  };
};

// Helper to update a single node's x/y position in the tree
export const updateNodePositionInTree = (root, targetNodeId, x, y) => {
  if (!root) return null;
  if (root.id === targetNodeId) {
    return { ...root, x, y };
  }
  return {
    ...root,
    rightChildren: (root.rightChildren || []).map(c => updateNodePositionInTree(c, targetNodeId, x, y)),
    children: (root.children || []).map(c => updateNodePositionInTree(c, targetNodeId, x, y))
  };
};

// Helper to delete a node from the tree
export const deleteNodeFromTree = (root, idToDelete) => {
  if (!root || root.id === idToDelete) return null;
  const filterChildren = (node) => {
    return {
      ...node,
      rightChildren: (node.rightChildren || [])
        .filter(c => c.id !== idToDelete)
        .map(filterChildren),
      children: (node.children || [])
        .filter(c => c.id !== idToDelete)
        .map(filterChildren)
    };
  };
  return filterChildren(root);
};

// Helper to update specific content of a node (notes, drawings, text)
export const updateNodeInTree = (node, nodeId, updates) => {
  if (!node) return null;
  if (node.id === nodeId) {
    return { ...node, ...updates };
  }
  return { 
    ...node, 
    rightChildren: (node.rightChildren || []).map(child => updateNodeInTree(child, nodeId, updates)),
    children: (node.children || []).map(child => updateNodeInTree(child, nodeId, updates)) 
  };
};

// Find a node by ID
export const findNodeById = (node, id) => {
  if (!node || !id) return null;
  if (node.id === id) return node;
  if (node.rightChildren) {
    for (const child of node.rightChildren) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
};

// Helper to check if a node is a leaf node (has NO children in either rightChildren or children)
export const isLeafNode = (node) => {
  if (!node) return false;
  const rightLen = node.rightChildren?.length || 0;
  const bottomLen = node.children?.length || 0;
  return rightLen === 0 && bottomLen === 0;
};

// Helper to update multiple node positions simultaneously by shiftDx, shiftDy from groupSnapshot
export const updateMultipleNodePositionsInTree = (root, groupSnapshot, shiftDx, shiftDy) => {
  if (!root || !groupSnapshot) return root;
  const traverse = (node) => {
    if (!node) return null;
    let nextX = node.x;
    let nextY = node.y;
    if (groupSnapshot[node.id]) {
      nextX = Math.round(groupSnapshot[node.id].x + shiftDx);
      nextY = Math.round(groupSnapshot[node.id].y + shiftDy);
    }
    return {
      ...node,
      x: nextX,
      y: nextY,
      rightChildren: (node.rightChildren || []).map(traverse),
      children: (node.children || []).map(traverse)
    };
  };
  return traverse(root);
};

// Helper to bulk delete multiple nodes from tree
export const deleteMultipleNodesFromTree = (root, idsToDeleteSet) => {
  if (!root || !idsToDeleteSet || idsToDeleteSet.size === 0) return root;
  if (idsToDeleteSet.has(root.id)) {
    return root;
  }
  const filterAndTraverse = (node) => {
    if (!node) return null;
    const nextRightChildren = (node.rightChildren || [])
      .filter(child => !idsToDeleteSet.has(child.id))
      .map(filterAndTraverse);
    const nextChildren = (node.children || [])
      .filter(child => !idsToDeleteSet.has(child.id))
      .map(filterAndTraverse);
    return {
      ...node,
      rightChildren: nextRightChildren,
      children: nextChildren
    };
  };
  return filterAndTraverse(root);
};

// Helper to bulk update text for multiple nodes
export const updateMultipleNodesText = (root, idsSet, newText) => {
  if (!root || !idsSet || idsSet.size === 0) return root;
  const traverse = (node) => {
    if (!node) return null;
    const text = idsSet.has(node.id) ? newText : node.text;
    return {
      ...node,
      text,
      rightChildren: (node.rightChildren || []).map(traverse),
      children: (node.children || []).map(traverse)
    };
  };
  return traverse(root);
};

// Helper to recursively find a node's immediate parent node
export const findParentNode = (root, childId) => {
  if (!root || !childId) return null;

  for (const child of (root.rightChildren || [])) {
    if (child && child.id === childId) {
      return root;
    }
    const found = findParentNode(child, childId);
    if (found) return found;
  }

  for (const child of (root.children || [])) {
    if (child && child.id === childId) {
      return root;
    }
    const found = findParentNode(child, childId);
    if (found) return found;
  }

  return null;
};

// Helper to extract and group multi-selected children by parentId + direction
export const getMultiSelectionFormatGroups = (root, selectedNodeIds) => {
  if (!root || !selectedNodeIds || selectedNodeIds.size < 2) {
    return { isMulti: false, validGroups: [], hasValidGroups: false, totalValidNodesCount: 0, totalSelectedCount: 0 };
  }

  const selectedArray = Array.from(selectedNodeIds);
  const groupsMap = new Map();

  for (const nodeId of selectedArray) {
    if (nodeId === root.id) {
      // Root node has no parent
      continue;
    }

    const parent = findParentNode(root, nodeId);
    if (!parent) continue;

    // Determine the child's logical direction relative to this parent
    const isRightChild = (parent.rightChildren || []).some(c => c && c.id === nodeId);
    const isBottomChild = (parent.children || []).some(c => c && c.id === nodeId);
    if (!isRightChild && !isBottomChild) continue;

    const childObj = (parent.rightChildren || []).find(c => c && c.id === nodeId) ||
                     (parent.children || []).find(c => c && c.id === nodeId);
    const side = getChildLogicalSide(childObj, isRightChild);

    const groupKey = `${parent.id}___${side}`;
    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        parent,
        direction: side,
        selectedNodeIds: new Set()
      });
    }
    groupsMap.get(groupKey).selectedNodeIds.add(nodeId);
  }

  const validGroups = [];
  groupsMap.forEach((group) => {
    // Only 'right' and 'down' directions can be formatted
    if ((group.direction === 'right' || group.direction === 'down') && group.selectedNodeIds.size >= 2) {
      // Extract items in natural sibling order from parent's direction group
      const allDirectional = getChildrenByDirection(group.parent)[group.direction] || [];
      const items = allDirectional.filter(child => group.selectedNodeIds.has(child.id));
      if (items.length >= 2) {
        validGroups.push({
          parent: group.parent,
          direction: group.direction,
          items,
          count: items.length
        });
      }
    }
  });

  return {
    isMulti: true,
    validGroups,
    hasValidGroups: validGroups.length > 0,
    totalValidNodesCount: validGroups.reduce((acc, g) => acc + g.items.length, 0),
    totalSelectedCount: selectedNodeIds.size
  };
};

// Helper to extract visible nodes respecting collapsed state
export const getVisibleNodes = (root, collapsedNodeIds = new Set()) => {
  if (!root) return [];
  const list = [];
  const traverse = (node) => {
    if (!node) return;
    list.push(node);
    // If node is collapsed, do NOT traverse its children into the visible list
    const isNodeCollapsed = collapsedNodeIds && (typeof collapsedNodeIds.has === 'function' ? collapsedNodeIds.has(node.id) : !!collapsedNodeIds[node.id]);
    if (isNodeCollapsed) {
      return;
    }
    (node.rightChildren || []).forEach(traverse);
    (node.children || []).forEach(traverse);
  };
  traverse(root);
  return list;
};

// Helper to extract visible connections respecting collapsed state
export const getVisibleConnections = (root, collapsedNodeIds = new Set()) => {
  if (!root) return [];
  const conns = [];
  const traverse = (node) => {
    if (!node) return;
    const isNodeCollapsed = collapsedNodeIds && (typeof collapsedNodeIds.has === 'function' ? collapsedNodeIds.has(node.id) : !!collapsedNodeIds[node.id]);
    if (isNodeCollapsed) {
      return;
    }
    (node.rightChildren || []).forEach(child => {
      const side = getChildLogicalSide(child, true);
      conns.push({
        id: `conn-${node.id}-${child.id}`,
        from: node,
        to: child,
        branchType: side
      });
      traverse(child);
    });
    (node.children || []).forEach(child => {
      const side = getChildLogicalSide(child, false);
      conns.push({
        id: `conn-${node.id}-${child.id}`,
        from: node,
        to: child,
        branchType: side
      });
      traverse(child);
    });
  };
  traverse(root);
  return conns;
};

