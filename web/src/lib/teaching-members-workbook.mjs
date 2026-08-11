import * as XLSX from "xlsx";
import { inflateRawSync } from "node:zlib";

// Teaching allocation 只能读取学校约定的工作表；名称和行数上限集中在这里，
// API 与自动化测试会调用同一个解析函数，避免测试复制一套不同的安全选项。
export const teachingMembersSheetName = "Teaching Members";
export const maximumTeachingMemberRows = 5_000;
export const maximumTeachingMembersZipEntries = 2_048;
export const maximumTeachingMembersUncompressedBytes = 128 * 1024 * 1024;
export const maximumTeachingMembersCompressionRatio = 200;

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectoryEntrySignature = 0x02014b50;
const localFileHeaderSignature = 0x04034b50;
const maximumZipCommentBytes = 65_535;

export class TeachingMembersWorkbookError extends Error {
  // 缺少目标表或超过安全行数都是老师可以修正的文件问题，API 会把这类错误稳定映射为 400。
  constructor(message) {
    super(message);
    this.name = "TeachingMembersWorkbookError";
  }
}

function findEndOfCentralDirectory(workbookBytes) {
  // ZIP 的目录摘要固定在文件尾部，后面最多只有 65,535 bytes 注释。由尾向前找并
  // 同时核对注释长度，可避免把工作表内容中偶然出现的相同四个 bytes 当成目录。
  const firstPossibleOffset = Math.max(0, workbookBytes.length - 22 - maximumZipCommentBytes);
  for (let offset = workbookBytes.length - 22; offset >= firstPossibleOffset; offset -= 1) {
    if (workbookBytes.readUInt32LE(offset) !== endOfCentralDirectorySignature) continue;
    const commentLength = workbookBytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === workbookBytes.length) return offset;
  }
  throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
}

function assertWorkbookArchiveResourceLimits(workbookBytes) {
  // .xlsx 是 ZIP 容器。先读取中央目录，再以严格输出上限逐项验证 Deflate 实际大小；
  // 因此攻击者不能靠伪造目录数字，把高压缩比文件绕到 SheetJS 才解压。
  if (!Buffer.isBuffer(workbookBytes) || workbookBytes.length < 22) {
    throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
  }
  const directoryEndOffset = findEndOfCentralDirectory(workbookBytes);
  const diskNumber = workbookBytes.readUInt16LE(directoryEndOffset + 4);
  const directoryDiskNumber = workbookBytes.readUInt16LE(directoryEndOffset + 6);
  const entriesOnDisk = workbookBytes.readUInt16LE(directoryEndOffset + 8);
  const totalEntries = workbookBytes.readUInt16LE(directoryEndOffset + 10);
  const directorySize = workbookBytes.readUInt32LE(directoryEndOffset + 12);
  const directoryOffset = workbookBytes.readUInt32LE(directoryEndOffset + 16);

  // 20 MB 上传不需要 ZIP64 或多盘格式。拒绝这些复杂变体，可以保证下面所有大小
  // 都来自同一份普通中央目录，而不是在未解析的扩展字段中被替换。
  if (
    diskNumber !== 0
    || directoryDiskNumber !== 0
    || entriesOnDisk !== totalEntries
    || totalEntries === 0xffff
    || directorySize === 0xffffffff
    || directoryOffset === 0xffffffff
  ) {
    throw new TeachingMembersWorkbookError("ZIP64 and multi-part .xlsx workbooks are not supported.");
  }
  if (totalEntries > maximumTeachingMembersZipEntries) {
    throw new TeachingMembersWorkbookError(`The .xlsx workbook must contain ${maximumTeachingMembersZipEntries.toLocaleString("en-US")} ZIP entries or fewer.`);
  }

  const centralDirectoryEnd = directoryOffset + directorySize;
  if (centralDirectoryEnd !== directoryEndOffset || centralDirectoryEnd > workbookBytes.length) {
    throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
  }

  let entryOffset = directoryOffset;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  let verifiedUncompressedBytes = 0;
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    // 每条中央目录记录先有 46 bytes 固定区，再接文件名、扩展字段和注释。
    // 所有边界都在读取前核对，损坏的长度不能把检查器带到 Buffer 之外。
    if (entryOffset + 46 > centralDirectoryEnd || workbookBytes.readUInt32LE(entryOffset) !== centralDirectoryEntrySignature) {
      throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
    }
    const generalPurposeFlag = workbookBytes.readUInt16LE(entryOffset + 8);
    const compressionMethod = workbookBytes.readUInt16LE(entryOffset + 10);
    const compressedBytes = workbookBytes.readUInt32LE(entryOffset + 20);
    const uncompressedBytes = workbookBytes.readUInt32LE(entryOffset + 24);
    const filenameLength = workbookBytes.readUInt16LE(entryOffset + 28);
    const extraFieldLength = workbookBytes.readUInt16LE(entryOffset + 30);
    const commentLength = workbookBytes.readUInt16LE(entryOffset + 32);
    const startingDisk = workbookBytes.readUInt16LE(entryOffset + 34);
    const localHeaderOffset = workbookBytes.readUInt32LE(entryOffset + 42);
    const nextEntryOffset = entryOffset + 46 + filenameLength + extraFieldLength + commentLength;

    if (
      startingDisk !== 0
      || compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || localHeaderOffset === 0xffffffff
      || nextEntryOffset > centralDirectoryEnd
    ) {
      throw new TeachingMembersWorkbookError("ZIP64 and multi-part .xlsx workbooks are not supported.");
    }
    // 教学工作簿只需要普通 Stored／Deflate 项；加密或其他算法既无法由系统审核，
    // 也不应在上传后才交给底层解析器猜测。
    if ((generalPurposeFlag & 0x0041) !== 0 || ![0, 8].includes(compressionMethod)) {
      throw new TeachingMembersWorkbookError("Encrypted or unsupported .xlsx ZIP entries are not allowed.");
    }

    totalCompressedBytes += compressedBytes;
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > maximumTeachingMembersUncompressedBytes) {
      throw new TeachingMembersWorkbookError("The .xlsx workbook expands beyond the 128 MB safety limit.");
    }
    if (
      uncompressedBytes > 0
      && (compressedBytes === 0 || uncompressedBytes > compressedBytes * maximumTeachingMembersCompressionRatio)
    ) {
      throw new TeachingMembersWorkbookError(`An .xlsx ZIP entry exceeds the ${maximumTeachingMembersCompressionRatio}:1 compression-ratio safety limit.`);
    }

    // 中央目录声明仍可能被恶意文件伪造。核对本地 header 和压缩资料范围后，用三重
    // 上限（声明大小、剩余总量、压缩比）验证实际 Deflate 输出，绝不无限解压。
    if (localHeaderOffset + 30 > directoryOffset || workbookBytes.readUInt32LE(localHeaderOffset) !== localFileHeaderSignature) {
      throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
    }
    const localFlag = workbookBytes.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = workbookBytes.readUInt16LE(localHeaderOffset + 8);
    const localCompressedBytes = workbookBytes.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedBytes = workbookBytes.readUInt32LE(localHeaderOffset + 22);
    const localFilenameLength = workbookBytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraFieldLength = workbookBytes.readUInt16LE(localHeaderOffset + 28);
    const compressedDataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraFieldLength;
    const compressedDataEnd = compressedDataOffset + compressedBytes;
    if (
      localFlag !== generalPurposeFlag
      || localCompressionMethod !== compressionMethod
      || compressedDataEnd > directoryOffset
      || ((generalPurposeFlag & 0x0008) === 0 && (localCompressedBytes !== compressedBytes || localUncompressedBytes !== uncompressedBytes))
    ) {
      throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
    }

    const compressedContent = workbookBytes.subarray(compressedDataOffset, compressedDataEnd);
    let actualUncompressedBytes;
    if (compressionMethod === 0) {
      actualUncompressedBytes = compressedContent.length;
    } else {
      const remainingWorkbookBytes = maximumTeachingMembersUncompressedBytes - verifiedUncompressedBytes;
      const ratioBytes = compressedBytes * maximumTeachingMembersCompressionRatio;
      const allowedOutputBytes = Math.min(uncompressedBytes, remainingWorkbookBytes, ratioBytes);
      try {
        // 多允许 1 byte 以便区分“刚好越界”并给出统一 400；更大的输出由 zlib 立即停止。
        const verifiedContent = inflateRawSync(compressedContent, { maxOutputLength: Math.max(1, allowedOutputBytes + 1) });
        actualUncompressedBytes = verifiedContent.length;
      } catch {
        throw new TeachingMembersWorkbookError("The .xlsx workbook could not be decompressed within its safety limits.");
      }
      if (actualUncompressedBytes > allowedOutputBytes) {
        throw new TeachingMembersWorkbookError("The .xlsx workbook could not be decompressed within its safety limits.");
      }
    }
    if (actualUncompressedBytes !== uncompressedBytes) {
      throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
    }
    verifiedUncompressedBytes += actualUncompressedBytes;
    entryOffset = nextEntryOffset;
  }

  // 单项限制阻止一个巨大 XML；整体限制再防止很多各自刚好低于门槛的小项合成炸弹。
  if (entryOffset !== centralDirectoryEnd) {
    throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
  }
  if (
    totalUncompressedBytes > 0
    && (totalCompressedBytes === 0 || totalUncompressedBytes > totalCompressedBytes * maximumTeachingMembersCompressionRatio)
  ) {
    throw new TeachingMembersWorkbookError(`The .xlsx workbook exceeds the ${maximumTeachingMembersCompressionRatio}:1 compression-ratio safety limit.`);
  }
  if (verifiedUncompressedBytes !== totalUncompressedBytes) {
    throw new TeachingMembersWorkbookError("The file could not be read as a valid .xlsx workbook.");
  }
}

export function parseTeachingMembersWorksheet(workbookBytes) {
  // 先用 ZIP 中央目录完成资源预检；只有通过后 SheetJS 才会解压和建立工作表对象。
  assertWorkbookArchiveResourceLimits(workbookBytes);
  // sheets 只让目标工作表建立单元格对象；sheetRows 包含表头，因此读取上限加 2：
  // 1 行表头、最多 5,000 行业务资料，再多读 1 行用来明确判断超限。
  const workbook = XLSX.read(workbookBytes, {
    type: "buffer",
    sheets: [teachingMembersSheetName],
    sheetRows: maximumTeachingMemberRows + 2,
  });

  // 合法 Excel 若没有约定名称的工作表，也不能猜测其他工作表结构后继续导入。
  const worksheet = workbook.Sheets[teachingMembersSheetName];
  if (!worksheet) {
    throw new TeachingMembersWorkbookError(`Sheet '${teachingMembersSheetName}' was not found.`);
  }

  // 空单元格统一保留为 null，后续业务验证可以准确区分缺值与数字 0。
  const sheetRows = XLSX.utils.sheet_to_json(worksheet, { defval: null });
  // SheetJS 在 sheetRows 截断原始范围时写入 !fullref；即使截断区前有大量空行，
  // 也必须拒绝整份文件，不能把尾部真实资料静默遗漏。
  const workbookWasTruncated = Boolean(worksheet["!fullref"]);
  if (workbookWasTruncated || sheetRows.length > maximumTeachingMemberRows) {
    throw new TeachingMembersWorkbookError("The Teaching Members sheet must contain 5,000 rows or fewer.");
  }

  return {
    sheetRows,
    // 自动化测试读取同一次生产解析的对象名称，直接证明 Decoy 没有被建立成 Worksheet；
    // API 本身不依赖该诊断字段，因此不会影响实际导入摘要。
    parsedWorksheetNames: Object.keys(workbook.Sheets),
  };
}
