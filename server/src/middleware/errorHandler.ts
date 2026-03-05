import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../types/index.js';

export class AppError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number = 500, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('Error:', err.message);

  if (err instanceof AppError) {
    const response: ApiError = {
      success: false,
      error: err.message,
      code: err.code,
    };
    res.status(err.statusCode).json(response);
    return;
  }

  // Handle database errors
  if (err.message.includes('SQLITE')) {
    res.status(500).json({
      success: false,
      error: 'Database error occurred',
      code: 'DATABASE_ERROR',
    });
    return;
  }

  // Generic error
  res.status(500).json({
    success: false,
    error: 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: 'Resource not found',
    code: 'NOT_FOUND',
  });
}
