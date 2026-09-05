interface GoogleDriveLogoProps {
  size?: number
  className?: string
}

export function GoogleDriveLogo({
  size = 24,
  className,
}: GoogleDriveLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 87.3 78"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M58.2 0H29.1L58.2 50.4h29.1L58.2 0z" fill="#FFC107" />
      <path d="M29.1 0L0 50.4l14.55 25.2 29.1-50.4L29.1 0z" fill="#00AC47" />
      <path d="M14.55 75.6h58.2L87.3 50.4H29.1L14.55 75.6z" fill="#2684FC" />
    </svg>
  )
}

export default GoogleDriveLogo
