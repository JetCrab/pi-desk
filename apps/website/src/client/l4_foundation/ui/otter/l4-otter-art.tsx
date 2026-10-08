import { useId, type RefObject } from 'react'

export function L4OtterArt({
  svgRef
}: {
  svgRef: RefObject<SVGSVGElement | null>
}): React.JSX.Element {
  const id = useId()
  const headId = `${id}-head`
  const maskId = `${id}-fur`
  // 画布含特效留白；外层按头像本身占位，保持下方文案的位置不变。
  return (
    <svg
      ref={svgRef}
      viewBox="0 0 640 560"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2 overflow-visible"
      style={{ width: '144.8%', height: '168.93%' }}
    >
      <g data-part="busy-dots" opacity="0" fill="currentColor">
        <circle cx="294" cy="481" r="5.5" />
        <circle cx="320" cy="481" r="5.5" />
        <circle cx="346" cy="481" r="5.5" />
      </g>
      <g data-part="head">
        <g transform="translate(64 20)">
          <defs>
            <path
              id={headId}
              d="M256 88C190 88 132 109 90 161C62 153 35 171 35 198C35 217 45 231 61 240L54 277C47 316 64 353 104 379C144 406 195 419 256 419C317 419 368 406 408 379C448 353 465 316 458 277L451 240C467 231 477 217 477 198C477 171 450 153 422 161C380 109 322 88 256 88Z"
            />
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
              <rect width="512" height="512" fill="white" />
              <path
                fill="black"
                d="M170 272C201 253 229 240 256 240C283 240 311 253 342 272C383 255 425 261 444 288C472 327 443 369 406 389C367 430 315 448 256 448C197 448 145 430 106 389C69 369 40 327 68 288C87 261 129 255 170 272Z"
              />
            </mask>
          </defs>
          <use href={`#${headId}`} fill="#F3E2C6" />
          <use href={`#${headId}`} fill="#B87945" mask={`url(#${maskId})`} />
          <g fill="#303030">
            <path d="M76 180C62 177 53 186 53 198C53 207 57 215 64 220L76 180Z" />
            <path d="M436 180C450 177 459 186 459 198C459 207 455 215 448 220L436 180Z" />
          </g>
          <g data-part="face">
            {(['left', 'right'] as const).map((side, index) => (
              <g
                key={side}
                data-part={`${side}-eye`}
                transform={`translate(${index === 0 ? 158 : 354} 239)`}
              >
                <path
                  data-part={`${side}-eye-shape`}
                  fill="#303030"
                  d="M-26 0a26 28 0 1 0 52 0a26 28 0 1 0-52 0"
                />
                <circle data-part={`${side}-eye-shine`} cx="8" cy="-11" r="6.5" fill="#fff" />
              </g>
            ))}
            <g data-part="cheeks" fill="#D69973" opacity="0">
              <ellipse cx="133" cy="316" rx="26" ry="13" />
              <ellipse cx="379" cy="316" rx="26" ry="13" />
            </g>
            <path
              fill="#303030"
              d="M219 269C219 254 240 254 256 254C272 254 293 254 293 269C293 282 276 299 256 303C236 299 219 282 219 269Z"
            />
            <g data-part="smile" stroke="#303030" strokeLinecap="round" strokeWidth="10">
              <path d="M256 300C256 317 246 327 232 327C220 327 211 322 207 314" />
              <path d="M256 300C256 317 266 327 280 327C292 327 301 322 305 314" />
            </g>
            <g data-part="mouth" opacity="0">
              <ellipse cx="256" cy="333" rx="16" ry="22" fill="#303030" />
              <ellipse cx="256" cy="347" rx="9" ry="5" fill="#D69973" />
            </g>
            <g stroke="#303030" strokeLinecap="round" strokeWidth="9">
              <path d="M101 298C116 293 132 292 146 292M110 327C123 318 135 312 148 310M411 298C396 293 380 292 366 292M402 327C389 318 377 312 364 310" />
            </g>
          </g>
        </g>
      </g>
      <g data-part="thoughts" fill="currentColor" opacity="0">
        <circle cx="504" cy="132" r="5" />
        <circle cx="524" cy="102" r="8" />
        <circle cx="544" cy="65" r="11" />
      </g>
      <g
        data-part="surprise"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        opacity="0"
      >
        <path d="M465 91L479 66M498 113L521 100M443 69L446 44" />
      </g>
      <g
        data-part="sleep"
        fill="currentColor"
        fontFamily="Arial,sans-serif"
        fontWeight="600"
        opacity="0"
      >
        <text x="479" y="137" fontSize="24">
          z
        </text>
        <text x="522" y="92" fontSize="32">
          z
        </text>
      </g>
      <g data-part="sparkles" opacity="0" fill="#BE8656">
        <path d="M93 158Q96 177 111 180Q96 184 93 202Q90 184 75 180Q90 177 93 158Z" />
        <path d="M545 126Q550 151 570 155Q550 159 545 184Q540 159 521 155Q540 151 545 126Z" />
        <circle cx="513" cy="76" r="5" />
      </g>
    </svg>
  )
}
