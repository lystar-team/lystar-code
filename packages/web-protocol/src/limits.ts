// 协议中的页面与字节上限。放在无 TypeBox 依赖的叶子模块，浏览器端只需要常量的模块
// 不必把整份 schema 定义拉进模块图。schema 与公共入口继续导出同一批常量。
export const MAX_TRANSCRIPT_PAGE_SIZE = 400;
export const MAX_TRANSCRIPT_SEARCH_LIMIT = 100;
export const MAX_GIT_HISTORY_PAGE_SIZE = 100;
export const MAX_PROJECT_FILE_CHUNK_BYTES = 256 * 1024;
