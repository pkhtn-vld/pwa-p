// --- общий модуль авторизации

import { handleRegister, handleLogin } from "./authPasskey.js";


const btnRegister = document.getElementById("register");
const btnLogin = document.getElementById("login");
const resultBlock = document.getElementById("result");


if (btnRegister) {
  btnRegister.addEventListener('click', () => handleRegister(resultBlock, btnRegister));
}

if (btnLogin) {
  btnLogin.addEventListener('click', () => handleLogin(resultBlock, btnLogin, btnRegister));
}
