import { Context } from 'hono';

export function successResponse(c: Context, data: unknown, status: 200 | 201 = 200) {
  return c.json({ success: true, data }, status);
}

export function errorResponse(
  c: Context,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500 = 400
) {
  return c.json({ success: false, error: message }, status);
}

export function paginatedResponse(
  c: Context,
  data: unknown[],
  total: number,
  page: number,
  limit: number
) {
  return c.json({
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
}
