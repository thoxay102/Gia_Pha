// ====================== tree-renderer.js ======================
// Cấu hình cho cây lớn
const TREE_CONFIG = {
    INITIAL_DEPTH: 2,           // Chỉ hiển thị 2 đời đầu
    MAX_VISIBLE_NODES: 200,     // Tối đa 200 node hiển thị cùng lúc
    BATCH_SIZE: 30,             // Mỗi lần tải 30 người con
    PRELOAD_DEPTH: 1,           // Preload 1 đời phía trước
    NODE_HEIGHT: 120,           // Chiều cao 1 node (px)
    NODE_WIDTH: 140,            // Chiều rộng 1 node (px)
    RENDER_DELAY: 50,           // Delay giữa các lần render (ms)
};

// ====================== 1. LRU CACHE CHO DỮ LIỆU ======================
class LRUCache {
    constructor(maxSize = 3000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    
    get(key) {
        const item = this.cache.get(key);
        if (item) {
            this.cache.delete(key);
            this.cache.set(key, item);
            return item;
        }
        return null;
    }
    
    set(key, value) {
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
    
    has(key) {
        return this.cache.has(key);
    }
    
    clear() {
        this.cache.clear();
    }
}

const nodeCache = new LRUCache(3000);
const childrenCache = new LRUCache(2000);

// ====================== 2. HÀM TẢI CON CHÁU CÓ PHÂN TRANG ======================
async function fetchChildrenPaginated(parentId, page = 0, limit = TREE_CONFIG.BATCH_SIZE) {
    const cacheKey = `children_${parentId}_${page}`;
    const cached = childrenCache.get(cacheKey);
    if (cached) return cached;
    
    const offset = page * limit;
    
    try {
        const { data, error, count } = await supabase
            .from("members")
            .select("*", { count: 'exact' })
            .eq("family_code", currentFamilyCode)
            .or(`fatherid.eq.${parentId},motherid.eq.${parentId}`)
            .order("generation", { ascending: true })
            .order("name", { ascending: true })
            .range(offset, offset + limit - 1);
        
        if (error) throw error;
        
        const result = {
            data: data || [],
            total: count || 0,
            page: page,
            hasMore: (offset + limit) < (count || 0)
        };
        
        childrenCache.set(cacheKey, result);
        return result;
        
    } catch (err) {
        console.error("Lỗi tải con:", err);
        return { data: [], total: 0, hasMore: false };
    }
}

// ====================== 3. TẢI THÔNG TIN CHI TIẾT 1 THÀNH VIÊN ======================
async function fetchMemberDetail(memberId) {
    const cacheKey = `member_${memberId}`;
    const cached = nodeCache.get(cacheKey);
    if (cached) return cached;
    
    try {
        const { data, error } = await supabase
            .from("members")
            .select("*")
            .eq("id", memberId)
            .eq("family_code", currentFamilyCode)
            .single();
        
        if (error) throw error;
        
        nodeCache.set(cacheKey, data);
        return data;
        
    } catch (err) {
        console.error("Lỗi tải chi tiết:", err);
        return null;
    }
}

// ====================== 4. RENDER 1 NODE (TỐI GIẢN) ======================
function renderSimpleNode(member, isExpanded = false, childrenCount = 0) {
    const isDeceased = member.is_deceased === true || 
        (member.years && member.years.includes('-') && member.years.split('-')[1]?.trim());
    
    const genderClass = member.gender === 'female' ? 'female' : 'male';
    const deceasedClass = isDeceased ? 'deceased' : '';
    const expandedClass = isExpanded ? 'expanded' : '';
    
    // Avatar: dùng text thay vì ảnh để tiết kiệm bộ nhớ
    const avatarHtml = member.avatar && member.avatar.startsWith('data:image') 
        ? `<div class="avatar-img" style="background-image:url('${member.avatar}')"></div>`
        : `<div class="avatar-text">${member.gender === 'female' ? '👩' : '👨'}</div>`;
    
    // Hiển thị năm sinh - năm mất gọn
    const yearText = member.birth_year ? 
        (member.death_year ? `${member.birth_year}-${member.death_year}` : `${member.birth_year}-nay`) :
        (member.years || '');
    
    return `
        <div class="tree-node ${genderClass} ${deceasedClass} ${expandedClass}" 
             data-id="${member.id}" 
             data-generation="${member.generation || 1}"
             data-expanded="${isExpanded}">
            <div class="node-avatar">${avatarHtml}</div>
            <div class="node-name" title="${escapeHtml(member.name)}">${escapeHtml(member.name).substring(0, 15)}${escapeHtml(member.name).length > 15 ? '...' : ''}</div>
            <div class="node-years">${yearText}</div>
            <div class="node-role">${member.role || ''}</div>
            ${childrenCount > 0 ? `<div class="node-children-count">${childrenCount}</div>` : ''}
            <button class="node-toggle" data-id="${member.id}" data-expanded="${isExpanded}">
                ${isExpanded ? '📂' : '📁'}
            </button>
        </div>
    `;
}

// ====================== 5. RENDER CÂY DẠNG FLAT (KHÔNG ĐỆ QUY) ======================
let flatTreeData = [];      // Mảng phẳng các node đang hiển thị
let visibleNodes = new Set(); // ID các node đang visible

async function buildFlatTree(rootId, maxDepth = TREE_CONFIG.INITIAL_DEPTH) {
    const result = [];
    const queue = [{ id: rootId, depth: 1, parentId: null, isExpanded: true }];
    const processed = new Set();
    
    while (queue.length > 0 && result.length < TREE_CONFIG.MAX_VISIBLE_NODES) {
        const { id, depth, parentId, isExpanded } = queue.shift();
        
        if (processed.has(id)) continue;
        processed.add(id);
        
        // Lấy thông tin member
        let member = members.find(m => m.id === id);
        if (!member) {
            member = await fetchMemberDetail(id);
            if (member && !members.find(m => m.id === id)) {
                members.push(member);
            }
        }
        
        if (!member) continue;
        
        // Lấy số lượng con (không lấy chi tiết)
        let childrenCount = 0;
        let hasMoreChildren = false;
        
        if (isExpanded && depth < maxDepth) {
            const childrenResult = await fetchChildrenPaginated(id, 0, 1); // Chỉ lấy count
            childrenCount = childrenResult.total;
            hasMoreChildren = childrenResult.hasMore;
        } else {
            // Ước lượng từ members có sẵn
            childrenCount = members.filter(m => m.fatherid === id || m.motherid === id).length;
        }
        
        // Thêm node vào kết quả
        result.push({
            id: member.id,
            name: member.name,
            gender: member.gender,
            generation: member.generation || depth,
            years: member.years,
            birth_year: member.birth_year,
            death_year: member.death_year,
            role: member.role,
            avatar: member.avatar,
            is_deceased: member.is_deceased,
            depth: depth,
            parentId: parentId,
            isExpanded: isExpanded,
            childrenCount: childrenCount,
            hasMoreChildren: hasMoreChildren
        });
        
        // Thêm con vào queue nếu expanded
        if (isExpanded && depth < maxDepth && childrenCount > 0) {
            // Chỉ lấy 1 trang con đầu tiên
            const childrenResult = await fetchChildrenPaginated(id, 0, 20);
            for (const child of childrenResult.data) {
                queue.push({ 
                    id: child.id, 
                    depth: depth + 1, 
                    parentId: id, 
                    isExpanded: expandedNodes.has(child.id) 
                });
            }
        }
    }
    
    return result;
}

// ====================== 6. VIRTUAL SCROLL RENDER ======================
let currentScrollTop = 0;
let rafId = null;
let containerHeight = 0;
let totalHeight = 0;
let startIndex = 0;
let endIndex = 0;

function calculateVisibleRange(scrollTop, containerHeight, nodeHeight = TREE_CONFIG.NODE_HEIGHT) {
    const start = Math.floor(scrollTop / nodeHeight);
    const end = Math.ceil((scrollTop + containerHeight) / nodeHeight);
    // Thêm buffer
    const buffer = 10;
    return {
        start: Math.max(0, start - buffer),
        end: end + buffer
    };
}

async function renderVirtualTree() {
    const container = document.getElementById('treeContainer');
    if (!container) return;
    
    const treeWrapper = document.querySelector('.tree-stage');
    if (!treeWrapper) return;
    
    // Lấy chiều cao container
    containerHeight = treeWrapper.clientHeight;
    
    // Xây dựng flat tree
    if (!stateRootId) return;
    
    showLoading("Đang xây dựng cây gia phả...", 10);
    
    flatTreeData = await buildFlatTree(stateRootId);
    totalHeight = flatTreeData.length * TREE_CONFIG.NODE_HEIGHT;
    
    // Tạo container ảo
    const virtualContainer = document.createElement('div');
    virtualContainer.style.position = 'relative';
    virtualContainer.style.height = totalHeight + 'px';
    virtualContainer.style.width = '100%';
    
    // Hàm render các node trong viewport
    const renderViewport = async () => {
        const scrollTop = treeWrapper.scrollTop;
        const range = calculateVisibleRange(scrollTop, containerHeight);
        
        if (range.start === startIndex && range.end === endIndex && rafId === null) return;
        
        startIndex = range.start;
        endIndex = range.end;
        
        // Giới hạn
        startIndex = Math.max(0, startIndex);
        endIndex = Math.min(flatTreeData.length, endIndex);
        
        // Xóa các node cũ
        virtualContainer.innerHTML = '';
        
        // Thêm các node mới trong viewport
        const fragment = document.createDocumentFragment();
        const nodesToRender = flatTreeData.slice(startIndex, endIndex);
        
        for (let i = 0; i < nodesToRender.length; i++) {
            const node = nodesToRender[i];
            const absoluteIndex = startIndex + i;
            const top = absoluteIndex * TREE_CONFIG.NODE_HEIGHT;
            
            const nodeDiv = document.createElement('div');
            nodeDiv.className = 'tree-node-wrapper';
            nodeDiv.style.position = 'absolute';
            nodeDiv.style.top = top + 'px';
            nodeDiv.style.left = '0';
            nodeDiv.style.width = '100%';
            nodeDiv.style.height = TREE_CONFIG.NODE_HEIGHT + 'px';
            nodeDiv.style.paddingLeft = (node.depth * 30) + 'px'; // Thụt đầu dòng theo đời
            
            nodeDiv.innerHTML = renderSimpleNode(node, node.isExpanded, node.childrenCount);
            fragment.appendChild(nodeDiv);
        }
        
        virtualContainer.appendChild(fragment);
        container.innerHTML = '';
        container.appendChild(virtualContainer);
        
        // Gắn sự kiện cho các nút toggle
        attachToggleEvents();
        
        rafId = null;
    };
    
    // Lắng nghe scroll với requestAnimationFrame
    const onScroll = () => {
        if (rafId) return;
        rafId = requestAnimationFrame(async () => {
            await renderViewport();
        });
    };
    
    treeWrapper.removeEventListener('scroll', onScroll);
    treeWrapper.addEventListener('scroll', onScroll);
    
    await renderViewport();
    hideLoading();
}

// ====================== 7. GẮN SỰ KIỆN TOGGLE ======================
function attachToggleEvents() {
    document.querySelectorAll('.node-toggle').forEach(btn => {
        if (btn.dataset.bound === 'true') return;
        
        btn.dataset.bound = 'true';
        btn.onclick = async (e) => {
            e.stopPropagation();
            const nodeId = parseInt(btn.dataset.id);
            const isExpanded = btn.dataset.expanded === 'true';
            
            if (isExpanded) {
                expandedNodes.delete(nodeId);
                btn.dataset.expanded = 'false';
                btn.innerHTML = '📁';
            } else {
                expandedNodes.add(nodeId);
                btn.dataset.expanded = 'true';
                btn.innerHTML = '📂';
                
                // Preload con cháu
                const childrenResult = await fetchChildrenPaginated(nodeId, 0, 20);
                for (const child of childrenResult.data) {
                    if (!members.find(m => m.id === child.id)) {
                        members.push(child);
                    }
                }
            }
            
            // Rebuild và render lại cây
            flatTreeData = await buildFlatTree(stateRootId);
            totalHeight = flatTreeData.length * TREE_CONFIG.NODE_HEIGHT;
            virtualContainer.style.height = totalHeight + 'px';
            await renderViewport();
        };
    });
}

// ====================== 8. TẢI THÊM CON CHÁU (PAGINATION) ======================
async function loadMoreChildren(parentId, currentPage) {
    const nextPage = currentPage + 1;
    const result = await fetchChildrenPaginated(parentId, nextPage);
    
    if (result.data.length > 0) {
        // Thêm vào members
        result.data.forEach(child => {
            if (!members.find(m => m.id === child.id)) {
                members.push(child);
            }
        });
        
        // Cập nhật expandedNodes để hiển thị
        expandedNodes.add(parentId);
        
        // Rebuild cây
        flatTreeData = await buildFlatTree(stateRootId);
        totalHeight = flatTreeData.length * TREE_CONFIG.NODE_HEIGHT;
        virtualContainer.style.height = totalHeight + 'px';
        await renderViewport();
        
        showToast(`✅ Đã tải thêm ${result.data.length} người con`);
    }
    
    return result.hasMore;
}

// ====================== 9. TÌM KIẾM VÀ NHẢY ĐẾN NODE ======================
async function searchAndJumpToNode(keyword) {
    if (!keyword || keyword.length < 2) {
        showToast("⚠️ Nhập ít nhất 2 ký tự để tìm kiếm");
        return;
    }
    
    showLoading("Đang tìm kiếm...", 30);
    
    try {
        // Tìm kiếm trên server
        const { data, error } = await supabase
            .from("members")
            .select("id, name, generation")
            .ilike("name", `%${keyword}%`)
            .eq("family_code", currentFamilyCode)
            .limit(20);
        
        if (error) throw error;
        
        if (!data || data.length === 0) {
            showToast("❌ Không tìm thấy thành viên nào");
            hideLoading();
            return;
        }
        
        // Hiển thị kết quả tìm kiếm
        let resultHtml = `<div style="max-height: 400px; overflow-y: auto;">
            <h4>🔍 Kết quả tìm kiếm "${keyword}"</h4>`;
        
        for (const member of data) {
            resultHtml += `
                <div class="search-result-item" data-id="${member.id}" 
                     style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer;">
                    <strong>${escapeHtml(member.name)}</strong><br>
                    <small>Đời thứ ${member.generation || '?'}</small>
                </div>
            `;
        }
        resultHtml += `</div>`;
        
        // Hiển thị modal kết quả
        const modal = document.getElementById('detailModal');
        document.getElementById('detailContent').innerHTML = resultHtml;
        modal.classList.add('active');
        
        // Gắn sự kiện click cho kết quả
        document.querySelectorAll('.search-result-item').forEach(item => {
            item.onclick = async () => {
                const nodeId = parseInt(item.dataset.id);
                modal.classList.remove('active');
                await jumpToNode(nodeId);
            };
        });
        
    } catch (err) {
        console.error("Lỗi tìm kiếm:", err);
        showToast("❌ Lỗi tìm kiếm");
    } finally {
        hideLoading();
    }
}

// ====================== 10. NHẢY ĐẾN NODE CỤ THỂ ======================
async function jumpToNode(nodeId) {
    showLoading("Đang định vị...", 30);
    
    try {
        // Tìm đường đi từ root đến node
        const path = await findPathToNode(stateRootId, nodeId);
        
        if (path.length === 0) {
            showToast("❌ Không thể định vị thành viên này");
            hideLoading();
            return;
        }
        
        // Mở rộng tất cả các node trên đường đi
        for (const ancestorId of path) {
            expandedNodes.add(ancestorId);
            // Preload con
            await fetchChildrenPaginated(ancestorId, 0, 20);
        }
        
        // Rebuild cây
        flatTreeData = await buildFlatTree(stateRootId);
        totalHeight = flatTreeData.length * TREE_CONFIG.NODE_HEIGHT;
        
        // Tìm vị trí của node trong flatTree
        const nodeIndex = flatTreeData.findIndex(n => n.id === nodeId);
        
        if (nodeIndex !== -1) {
            const scrollTop = nodeIndex * TREE_CONFIG.NODE_HEIGHT - containerHeight / 2;
            const treeWrapper = document.querySelector('.tree-stage');
            if (treeWrapper) {
                treeWrapper.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
            }
            
            // Highlight node
            setTimeout(() => {
                const nodeElement = document.querySelector(`.tree-node[data-id="${nodeId}"]`);
                if (nodeElement) {
                    nodeElement.classList.add('highlight');
                    setTimeout(() => {
                        nodeElement.classList.remove('highlight');
                    }, 2000);
                }
            }, 500);
            
            showToast(`✅ Đã tìm thấy ${flatTreeData[nodeIndex].name}`);
        } else {
            showToast("⚠️ Đã mở rộng cây nhưng không thấy node, vui lòng cuộn để tìm");
        }
        
    } catch (err) {
        console.error("Lỗi nhảy đến node:", err);
        showToast("❌ Lỗi định vị");
    } finally {
        hideLoading();
    }
}

// Tìm đường đi từ root đến node
async function findPathToNode(rootId, targetId, path = []) {
    if (rootId === targetId) {
        return [...path, rootId];
    }
    
    const childrenResult = await fetchChildrenPaginated(rootId, 0, 100);
    
    for (const child of childrenResult.data) {
        const result = await findPathToNode(child.id, targetId, [...path, rootId]);
        if (result.length > 0) {
            return result;
        }
    }
    
    return [];
}

// ====================== 11. KHỞI TẠO ======================
async function initLargeTree() {
    console.log("🌳 Khởi tạo cây gia phả lớn...");
    
    // Tìm root
    if (!stateRootId) {
        const { data } = await supabase
            .from("members")
            .select("id")
            .is("fatherid", null)
            .is("motherid", null)
            .eq("family_code", currentFamilyCode)
            .limit(1);
        
        if (data && data[0]) {
            stateRootId = data[0].id;
        }
    }
    
    if (!stateRootId && members.length > 0) {
        stateRootId = members[0].id;
    }
    
    if (!stateRootId) {
        document.getElementById('treeContainer').innerHTML = `
            <div class="tree-empty">
                <i class="fas fa-tree fa-3x"></i>
                <p>Chưa có dữ liệu thành viên</p>
                <button class="btn btn-primary" onclick="openMemberModal()">Thêm thành viên đầu tiên</button>
            </div>
        `;
        return;
    }
    
    // Reset expanded nodes
    expandedNodes.clear();
    expandedNodes.add(stateRootId);
    
    // Render virtual tree
    await renderVirtualTree();
    
    // Thêm thanh tìm kiếm
    addSearchBar();
}

// Thêm thanh tìm kiếm vào toolbar
function addSearchBar() {
    const toolbar = document.getElementById('treeToolbar');
    if (!toolbar || document.getElementById('treeSearchInput')) return;
    
    const searchDiv = document.createElement('div');
    searchDiv.style.display = 'flex';
    searchDiv.style.gap = '8px';
    searchDiv.style.marginLeft = 'auto';
    
    searchDiv.innerHTML = `
        <input type="text" id="treeSearchInput" placeholder="🔍 Tìm kiếm thành viên..." 
               style="padding: 6px 12px; border-radius: 20px; border: 1px solid #ddd; width: 150px;">
        <button id="treeSearchBtn" class="btn btn-primary btn-sm" style="padding: 6px 12px;">
            <i class="fas fa-search"></i>
        </button>
    `;
    
    toolbar.appendChild(searchDiv);
    
    document.getElementById('treeSearchBtn').onclick = () => {
        const keyword = document.getElementById('treeSearchInput').value.trim();
        if (keyword) searchAndJumpToNode(keyword);
    };
    
    document.getElementById('treeSearchInput').onkeypress = (e) => {
        if (e.key === 'Enter') {
            const keyword = e.target.value.trim();
            if (keyword) searchAndJumpToNode(keyword);
        }
    };
}

// ====================== CSS CHO CÂY LỚN ======================
const largeTreeCSS = `
    .tree-stage {
        position: relative;
        overflow: auto;
        height: 70vh;
        min-height: 500px;
        background: #fdfaf1;
        border-radius: 24px;
    }
    
    #treeContainer {
        position: relative;
        min-height: 100%;
    }
    
    .tree-node-wrapper {
        transition: background 0.2s;
        border-bottom: 1px solid rgba(139,69,19,0.1);
    }
    
    .tree-node-wrapper:hover {
        background: rgba(184,134,11,0.05);
    }
    
    .tree-node {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 16px;
        background: white;
        border-radius: 12px;
        margin: 4px 8px;
        border: 1px solid #e5e7eb;
        cursor: pointer;
        transition: all 0.2s;
        position: relative;
    }
    
    .tree-node:hover {
        transform: translateX(4px);
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    
    .tree-node.highlight {
        background: #fff8e1;
        border: 2px solid #b8860b;
        animation: pulse 0.5s ease;
    }
    
    @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.02); }
        100% { transform: scale(1); }
    }
    
    .tree-node.male {
        border-left: 4px solid #2d5a27;
    }
    
    .tree-node.female {
        border-left: 4px solid #8e2121;
    }
    
    .tree-node.deceased {
        opacity: 0.7;
        background: #f5f5f5;
    }
    
    .node-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #f0e9d8;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        flex-shrink: 0;
    }
    
    .avatar-img {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background-size: cover;
        background-position: center;
    }
    
    .avatar-text {
        font-size: 20px;
    }
    
    .node-name {
        flex: 1;
        font-weight: 600;
        font-size: 14px;
        color: #1b3022;
    }
    
    .node-years {
        font-size: 11px;
        color: #666;
        min-width: 80px;
    }
    
    .node-role {
        font-size: 11px;
        color: #b8860b;
        background: #fff0e0;
        padding: 2px 8px;
        border-radius: 12px;
        min-width: 60px;
        text-align: center;
    }
    
    .node-children-count {
        background: #2d5a27;
        color: white;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 20px;
        min-width: 24px;
        text-align: center;
    }
    
    .node-toggle {
        background: none;
        border: none;
        font-size: 16px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 20px;
        transition: all 0.2s;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    
    .node-toggle:hover {
        background: rgba(184,134,11,0.2);
        transform: scale(1.1);
    }
    
    .tree-toolbar {
        position: sticky;
        top: 0;
        background: white;
        padding: 8px 12px;
        margin-bottom: 12px;
        border-radius: 30px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        z-index: 100;
        border: 1px solid #e5e7eb;
        box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    
    @media (max-width: 768px) {
        .node-years, .node-role {
            display: none;
        }
        
        .tree-node {
            padding: 6px 12px;
        }
        
        .node-name {
            font-size: 12px;
        }
        
        .node-avatar {
            width: 32px;
            height: 32px;
            font-size: 16px;
        }
    }
`;

// Thêm CSS vào document
const styleSheet = document.createElement('style');
styleSheet.textContent = largeTreeCSS;
document.head.appendChild(styleSheet);