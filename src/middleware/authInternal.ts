import { Request, Response, NextFunction } from 'express';

export const authInternal = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers['x-internal-token'];

  if (!token || token !== process.env.INTERNAL_SERVICE_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
