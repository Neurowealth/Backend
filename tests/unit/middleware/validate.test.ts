import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../../../src/middleware/validate';

describe('Validation Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction = jest.fn();

  beforeEach(() => {
    mockRequest = {
      body: {},
      query: {},
      params: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    nextFunction = jest.fn();
  });

  const testSchema = z.object({
    name: z.string().min(2),
    age: z.number().int().positive(),
  });

  it('should call next() when validation passes', () => {
    mockRequest.body = { name: 'Alice', age: 30 };
    const middleware = validate({ body: testSchema });

    middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it('should return 400 when validation fails', () => {
    mockRequest.body = { name: 'A', age: -5 };
    const middleware = validate({ body: testSchema });

    middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({ path: 'name' }),
          expect.objectContaining({ path: 'age' }),
        ]),
      })
    );
  });

  it('should format body according to zod transforms if used', () => {
    const transformSchema = z.object({
      id: z.string().transform((val) => Number(val)),
    });
    mockRequest.params = { id: '123' };
    const middleware = validate({ params: transformSchema });

    middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    expect(mockRequest.params).toEqual({ id: 123 });
  });

  it('should handle missing fields properly', () => {
    mockRequest.body = { name: 'Bob' }; // Missing 'age'
    const middleware = validate({ body: testSchema });

    middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({ path: 'age', message: 'Required' }),
        ]),
      })
    );
  });
});
