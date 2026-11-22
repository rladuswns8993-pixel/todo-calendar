// Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹)에 나오는 firebaseConfig 값이에요.
// 이 값들은 비밀번호가 아니라 "어느 프로젝트에 연결할지" 알려주는 주소 정보라서 공개돼도 괜찮아요.
// 실제 데이터 보호는 firestore.rules(본인 로그인 계정만 읽고 쓰기)가 담당해요.
export const firebaseConfig = {
  apiKey: "AIzaSyCeBMZjlS9ptnn_u8-XmJOE7D5R9_d-IjE",
  authDomain: "todo-calendar-c630c.firebaseapp.com",
  projectId: "todo-calendar-c630c",
  storageBucket: "todo-calendar-c630c.firebasestorage.app",
  messagingSenderId: "866472519151",
  appId: "1:866472519151:web:b6c569009f122e87c4021a",
};
