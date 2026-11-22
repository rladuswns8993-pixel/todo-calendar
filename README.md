# 투두 캘린더

PC와 폰이 연동되는 개인 투두 캘린더 (PWA). 다크 그라파이트 디자인.

- 날짜 클릭 → 사이드바에 그날 **할 일**과 **밀린 일** 표시
- 체크하면 가운데 줄, 할 일 박스를 끌어서 다른 날짜로 이동 (폰은 길게 눌러서)
- Firebase에 저장 → PC·폰 실시간 연동, 오프라인에서도 동작 후 자동 동기화

## 구성

| 파일 | 역할 |
|---|---|
| `index.html`, `style.css`, `app.js` | 앱 화면과 동작 |
| `firebase-config.js` | 연결할 Firebase 프로젝트 주소 (공개돼도 되는 값) |
| `firestore.rules` | 데이터 보호 규칙 — 로그인한 본인만 읽고 쓰기 |
| `manifest.webmanifest`, `sw.js`, `icons/` | 앱 설치·오프라인 실행 |

외부에서 불러오는 것은 Firebase 공식 SDK(`www.gstatic.com`)와 Pretendard 글꼴(`cdn.jsdelivr.net`)뿐이고,
`index.html`의 Content-Security-Policy가 그 외 출처의 스크립트 실행을 막아요.

## Firebase 설정 (처음 한 번)

1. https://console.firebase.google.com → **프로젝트 추가** (Google 애널리틱스는 꺼도 됨)
2. 프로젝트 개요 → **웹 앱 추가(`</>`)** → 앱 닉네임 입력 → 나오는 `firebaseConfig` 값을 `firebase-config.js`에 붙여넣기
3. **Authentication** → 시작하기 → 로그인 방법 → **이메일/비밀번호** 사용 설정
4. **Firestore Database** → 데이터베이스 만들기 → 위치 `asia-northeast3 (서울)` → 프로덕션 모드
   → **규칙** 탭에 `firestore.rules` 내용을 붙여넣고 **게시**
5. 앱에서 계정을 만든 뒤: Authentication → 설정 → 사용자 작업 → **생성(가입) 허용 해제**
   (다른 사람이 계정을 만들지 못하게)

## 설치

- **PC**: 크롬/엣지로 사이트 열기 → 주소창 오른쪽 **앱 설치** 아이콘
- **아이폰**: 사파리로 열기 → 공유 → **홈 화면에 추가**
- **안드로이드**: 크롬으로 열기 → 메뉴 → **홈 화면에 추가 / 앱 설치**
