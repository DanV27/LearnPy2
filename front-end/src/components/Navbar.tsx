import React from 'react';
import './Navbar.css';
import logo from '/assets/logo.png'

function logonav(){
  return <img src={logo} alt='logo' />
}


const Navbar = () => {
  return (

<nav className="navbar">
  <div className="navbar-left">
    <img src={logo} alt = "LearnPy Logo" className = "logo"/>
    <a href="/" className="logo">
      LearnPy
    </a>
  </div>
  <div className="navbar-center">
    <ul className="nav-links">
      <li>
        <a href="/Lessons">Lessons</a>
      </li>
      <li>
        <a href="/cheat-sheets">Cheat Sheets</a>
      </li>
      <li>
        <a href="/about">About</a>
      </li>
    </ul>
  </div>
  <div className="navbar-right">
    Settings
  </div>
</nav>
);
};

export default Navbar;