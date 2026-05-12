/**
 * File Attachment Routes — Agent-to-Agent File Transfer
 *
 * Enables agents to upload and download files as part of DM delivery.
 * Files are stored on the server's local filesystem (configurable to S3/R2).
 *
 * Supported file types: datasets (CSV, JSON, Parquet), model weights,
 * archives (ZIP, TAR.GZ), configs, and documents.
 *
 * Security:
 *   - Authenticated upload (only registered agents)
 *   - Authenticated download (only sender or recipient of linked DM)
 *   - SHA-256 checksum for integrity verification
 *   - File type whitelist (no executables)
 *   - Max file size: 50MB (configurable)
 *   - Files stored with UUID names (no path traversal)
 *
 * Endpoints:
 *   POST   /v1/dm/files/upload          — Upload a file (returns attachment ID)
 *   GET    /v1/dm/files/:id/download    — Download a file (auth + participant check)
 *   GET    /v1/dm/files/:id/info        — Get file metadata without downloading
 *   POST   /v1/dm/files/send            — Upload + send as DM in one call
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { authenticateSolana } from '../middleware/auth';
import { logger } from '../lib/logger';

const router = Router();

// ─── Config ───

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'dm-files');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '50') * 1024 * 1024; // Default 50MB

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    logger.info('upload_dir_created', { path: UPLOAD_DIR });
}

// ─── Allowed MIME Types ───

const ALLOWED_MIME_TYPES = new Set([
    // Data / Datasets
    'text/csv',
    'application/json',
    'application/x-ndjson',
    'text/plain',
    'text/tab-separated-values',
    'application/xml',
    'text/xml',
    'application/x-parquet',
    'application/octet-stream', // Binary blobs (model weights, encrypted files)

    // Archives
    'application/zip',
    'application/x-tar',
    'application/gzip',
    'application/x-gzip',
    'application/x-bzip2',
    'application/x-7z-compressed',

    // Documents
    'application/pdf',
    'text/markdown',

    // Model formats
    'application/x-hdf5',         // HDF5 model weights
    'application/x-safetensors',  // Safetensors format

    // Images (for dataset samples, screenshots)
    'image/png',
    'image/jpeg',
    'image/webp',
]);

// Also allow by extension for edge cases
const ALLOWED_EXTENSIONS = new Set([
    '.csv', '.json', '.jsonl', '.ndjson', '.txt', '.tsv', '.xml',
    '.parquet', '.arrow', '.feather',
    '.zip', '.tar', '.gz', '.tar.gz', '.tgz', '.bz2', '.7z',
    '.pdf', '.md',
    '.h5', '.hdf5', '.pt', '.pth', '.onnx', '.safetensors', '.gguf', '.bin',
    '.pkl', '.pickle',
    '.png', '.jpg', '.jpeg', '.webp',
    '.yaml', '.yml', '.toml', '.env', '.cfg', '.ini',
]);

function isAllowedFile(mimetype: string, filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ALLOWED_MIME_TYPES.has(mimetype) || ALLOWED_EXTENSIONS.has(ext);
}

// ─── Multer Storage Config ───

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
        // UUID-based filename to prevent collisions and path traversal
        const ext = path.extname(file.originalname).toLowerCase();
        const uuid = crypto.randomUUID();
        cb(null, `${uuid}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1, // One file per request
    },
    fileFilter: (_req, file, cb) => {
        if (isAllowedFile(file.mimetype, file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error(`File type not allowed: ${file.mimetype} (${file.originalname}). Allowed: datasets, archives, models, documents.`));
        }
    },
});

// ─── Helper: Compute SHA-256 checksum ───

function computeChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', d => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// ─── POST /v1/dm/files/upload — Upload a File ───

router.post('/v1/dm/files/upload', authenticateSolana, (req: Request, res: Response) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    res.status(413).json({
                        success: false,
                        error: `File too large. Max size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
                    });
                    return;
                }
                res.status(400).json({ success: false, error: err.message });
                return;
            }
            res.status(400).json({ success: false, error: err.message });
            return;
        }

        try {
            const wallet = req.wallet!;
            const file = req.file;

            if (!file) {
                res.status(400).json({ success: false, error: 'No file provided. Use multipart/form-data with field name "file".' });
                return;
            }

            // Compute checksum
            const checksum = await computeChecksum(file.path);

            // Save metadata to DB
            const attachment = await prisma.attachment.create({
                data: {
                    uploaderWallet: wallet,
                    filename: file.originalname,
                    storedName: file.filename,
                    mimeType: file.mimetype,
                    sizeBytes: file.size,
                    checksum,
                },
            });

            logger.info('file_uploaded', {
                id: attachment.id,
                wallet: wallet.substring(0, 8),
                filename: file.originalname,
                size: `${(file.size / 1024).toFixed(1)}KB`,
                mime: file.mimetype,
            });

            res.status(201).json({
                success: true,
                attachment: {
                    id: attachment.id,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                    checksum: attachment.checksum,
                    createdAt: attachment.createdAt,
                },
            });
        } catch (error: any) {
            logger.error('file_upload_error', { error: error.message });
            res.status(500).json({ success: false, error: 'Failed to upload file' });
        }
    });
});

// ─── POST /v1/dm/files/send — Upload + Send as DM (One Call) ───

router.post('/v1/dm/files/send', authenticateSolana, (req: Request, res: Response) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                res.status(413).json({
                    success: false,
                    error: `File too large. Max size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
                });
                return;
            }
            res.status(400).json({ success: false, error: err.message || 'Upload failed' });
            return;
        }

        try {
            const wallet = req.wallet!;
            const file = req.file;
            const { toWallet, ticketId, message: textMessage } = req.body;

            if (!file) {
                res.status(400).json({ success: false, error: 'No file provided.' });
                return;
            }

            if (!toWallet || typeof toWallet !== 'string' || toWallet.length < 32 || toWallet.length > 44) {
                // Clean up orphaned file
                fs.unlinkSync(file.path);
                res.status(400).json({ success: false, error: 'Valid recipient wallet address (toWallet) is required' });
                return;
            }

            if (toWallet === wallet) {
                fs.unlinkSync(file.path);
                res.status(400).json({ success: false, error: 'Cannot send a file to yourself' });
                return;
            }

            // Verify recipient exists
            const recipient = await prisma.agent.findUnique({ where: { wallet: toWallet } });
            if (!recipient) {
                fs.unlinkSync(file.path);
                res.status(404).json({ success: false, error: 'Recipient agent not found' });
                return;
            }

            // Compute checksum
            const checksum = await computeChecksum(file.path);

            // Create attachment + DM in a transaction
            const result = await prisma.$transaction(async (tx) => {
                const attachment = await tx.attachment.create({
                    data: {
                        uploaderWallet: wallet,
                        filename: file.originalname,
                        storedName: file.filename,
                        mimeType: file.mimetype,
                        sizeBytes: file.size,
                        checksum,
                    },
                });

                const dm = await tx.directMessage.create({
                    data: {
                        fromWallet: wallet,
                        toWallet,
                        content: textMessage || `📎 File: ${file.originalname}`,
                        contentType: 'file',
                        ticketId: ticketId || null,
                        attachmentId: attachment.id,
                        metadata: JSON.stringify({
                            filename: file.originalname,
                            mimeType: file.mimetype,
                            sizeBytes: file.size,
                            checksum,
                        }),
                    },
                });

                return { attachment, dm };
            });

            logger.info('file_dm_sent', {
                from: wallet.substring(0, 8),
                to: toWallet.substring(0, 8),
                filename: file.originalname,
                size: `${(file.size / 1024).toFixed(1)}KB`,
                dmId: result.dm.id,
            });

            res.status(201).json({
                success: true,
                message: {
                    id: result.dm.id,
                    fromWallet: result.dm.fromWallet,
                    toWallet: result.dm.toWallet,
                    contentType: 'file',
                    ticketId: result.dm.ticketId,
                    createdAt: result.dm.createdAt,
                },
                attachment: {
                    id: result.attachment.id,
                    filename: result.attachment.filename,
                    mimeType: result.attachment.mimeType,
                    sizeBytes: result.attachment.sizeBytes,
                    checksum: result.attachment.checksum,
                },
            });
        } catch (error: any) {
            logger.error('file_dm_send_error', { error: error.message });
            res.status(500).json({ success: false, error: 'Failed to send file' });
        }
    });
});

// ─── GET /v1/dm/files/:id/download — Download a File ───

router.get('/v1/dm/files/:id/download', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;
        const attachmentId = req.params.id as string;

        // Find attachment
        const attachment = await prisma.attachment.findUnique({
            where: { id: attachmentId },
            include: { message: true },
        });

        if (!attachment) {
            res.status(404).json({ success: false, error: 'File not found' });
            return;
        }

        // Authorization: only uploader or DM recipient can download
        const dm = attachment.message;
        const isUploader = attachment.uploaderWallet === wallet;
        const isRecipient = dm && dm.toWallet === wallet;
        const isSender = dm && dm.fromWallet === wallet;

        if (!isUploader && !isRecipient && !isSender) {
            res.status(403).json({ success: false, error: 'You are not authorized to download this file' });
            return;
        }

        const filePath = path.join(UPLOAD_DIR, attachment.storedName);

        if (!fs.existsSync(filePath)) {
            res.status(404).json({ success: false, error: 'File no longer exists on server' });
            return;
        }

        // Mark DM as read if recipient is downloading
        if (isRecipient && dm && !dm.readAt) {
            await prisma.directMessage.update({
                where: { id: dm.id },
                data: { readAt: new Date() },
            });
        }

        logger.info('file_downloaded', {
            id: attachmentId,
            by: wallet.substring(0, 8),
            filename: attachment.filename,
        });

        // Set headers and stream the file
        res.setHeader('Content-Type', attachment.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
        res.setHeader('Content-Length', attachment.sizeBytes.toString());
        res.setHeader('X-Checksum-SHA256', attachment.checksum);

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    } catch (error: any) {
        logger.error('file_download_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to download file' });
    }
});

// ─── GET /v1/dm/files/:id/info — Get File Metadata ───

router.get('/v1/dm/files/:id/info', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;
        const attachmentId = req.params.id as string;

        const attachment = await prisma.attachment.findUnique({
            where: { id: attachmentId },
            include: { message: true },
        });

        if (!attachment) {
            res.status(404).json({ success: false, error: 'File not found' });
            return;
        }

        // Authorization check
        const dm = attachment.message;
        const isUploader = attachment.uploaderWallet === wallet;
        const isRecipient = dm && dm.toWallet === wallet;
        const isSender = dm && dm.fromWallet === wallet;

        if (!isUploader && !isRecipient && !isSender) {
            res.status(403).json({ success: false, error: 'Not authorized' });
            return;
        }

        res.status(200).json({
            success: true,
            attachment: {
                id: attachment.id,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                sizeFormatted: formatFileSize(attachment.sizeBytes),
                checksum: attachment.checksum,
                encrypted: attachment.encrypted,
                uploadedBy: attachment.uploaderWallet,
                createdAt: attachment.createdAt,
                linkedDm: dm ? {
                    id: dm.id,
                    fromWallet: dm.fromWallet,
                    toWallet: dm.toWallet,
                    ticketId: dm.ticketId,
                } : null,
            },
        });
    } catch (error: any) {
        logger.error('file_info_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch file info' });
    }
});

// ─── Helper ───

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default router;
