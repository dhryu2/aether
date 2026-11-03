/** 그림 원본 비율(475×512). 상자 높이를 주면 너비가 따라온다. */
const ASPECT = 475 / 512

/** 마스코트가 차지할 너비. 자리를 미리 비워 둘 때 쓴다(높이만 알면 된다). */
export const chamdingWidth = (height: number) => Math.round(height * ASPECT)
