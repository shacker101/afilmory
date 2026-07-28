import { photoLoader } from '~/lib/photo-loader'

export const GET = async (_request: Request, { params }: { params: Promise<{ photoId: string }> }) => {
  const { photoId } = await params
  const photo = photoLoader.getPhoto(photoId)

  if (!photo?.thumbnailUrl) {
    return new Response(null, { status: 404 })
  }

  return new Response(null, {
    status: 302,
    headers: { Location: photo.thumbnailUrl },
  })
}
